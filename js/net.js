// Small fetch wrapper: timeouts, retry with backoff on 429/5xx, and readable errors.

export class NetworkError extends Error {
  constructor(message, { host, status } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.host = host;
    this.status = status;
  }
}

export class NotFoundError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NotFoundError';
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Client-side token buckets. upload.wikimedia.org allows a burst of ~4 files, then roughly one every 2-3 s per IP,
// and its Retry-After header isn't readable cross-origin, so we pace ourselves instead of hammering it.
const HOST_LIMITS = {
  'upload.wikimedia.org': { burst: 4, interval: 2600 },
  'www.wikidata.org': { burst: 5, interval: 400 },
  'commons.wikimedia.org': { burst: 6, interval: 250 },
  'en.wikipedia.org': { burst: 4, interval: 300 },
};
const buckets = new Map();

function bucket(host) {
  const lim = HOST_LIMITS[host];
  if (!lim) return null;
  if (!buckets.has(host)) buckets.set(host, { ...lim, tokens: lim.burst, last: Date.now(), chain: Promise.resolve() });
  return buckets.get(host);
}

function throttle(host) {
  const b = bucket(host);
  if (!b) return Promise.resolve();
  const turn = b.chain.then(async () => {
    const refill = () => {
      const now = Date.now();
      b.tokens = Math.min(b.burst, b.tokens + (now - b.last) / b.interval);
      b.last = now;
    };
    refill();
    if (b.tokens < 1) {
      await sleep((1 - b.tokens) * b.interval);
      refill();
    }
    b.tokens -= 1;
  });
  b.chain = turn;
  return turn;
}

/** After a 429, empty the bucket so every queued request for that host backs off. */
function penalize(host) {
  const b = bucket(host);
  if (b) {
    b.tokens = -1.5;
    b.last = Date.now();
  }
}

const cache = new Map();

/**
 * @param {string|URL} url
 * @param {{as?: 'json'|'blob'|'text', timeout?: number, retries?: number}} opts
 */
export function fetchWithRetry(url, opts = {}) {
  const key = `${opts.as || 'json'} ${url}`;
  if (!cache.has(key)) {
    const p = fetchUncached(url, opts);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

async function fetchUncached(url, { as = 'json', timeout = 15000, retries = 3 } = {}) {
  const host = new URL(url).host;
  if (HOST_LIMITS[host]) retries = Math.max(retries, 4);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new NetworkError(
          res.status === 429 ? `${host} is rate-limiting requests (HTTP 429)` : `${host} returned HTTP ${res.status}`,
          { host, status: res.status },
        );
        if (attempt < retries) {
          if (res.status === 429) penalize(host);
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(retryAfter > 0 ? Math.min(retryAfter, 20) * 1000 : (HOST_LIMITS[host] ? 600 : 1000) * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new NotFoundError(`${host} returned HTTP ${res.status}`, res.status);
      if (as === 'blob') return await res.blob();
      if (as === 'text') return await res.text();
      return await res.json();
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      if (err instanceof NetworkError && err === lastErr && attempt >= retries) throw err;
      lastErr = err.name === 'AbortError'
        ? new NetworkError(`Timed out contacting ${host}`, { host })
        : err instanceof NetworkError ? err
        : new NetworkError(`Could not reach ${host} (offline, blocked, or CORS)`, { host });
      if (attempt < retries) await sleep(700 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Call a MediaWiki API (Wikidata / Commons) anonymously with CORS enabled. */
export function mwApi(base, params, opts) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('format', 'json');
  u.searchParams.set('formatversion', '2');
  u.searchParams.set('origin', '*');
  return fetchWithRetry(u, opts);
}
