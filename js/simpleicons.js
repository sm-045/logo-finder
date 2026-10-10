// Simple Icons: single-colour brand icons + official brand colour (CC0 icon data, marks belong to their owners).
import { fetchWithRetry } from './net.js';
import { normName, normDomain } from './wikidata.js';

const VERSION = '16';
const DATA_URL = `https://cdn.jsdelivr.net/npm/simple-icons@${VERSION}/data/simple-icons.json`;
export const iconUrl = (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@${VERSION}/icons/${slug}.svg`;

let dataPromise = null;

function loadData() {
  if (!dataPromise) {
    dataPromise = fetchWithRetry(DATA_URL, { timeout: 20000, retries: 2 }).catch((e) => {
      dataPromise = null; // allow retry on next search
      throw e;
    });
  }
  return dataPromise;
}

// Same algorithm Simple Icons uses to derive slugs from titles.
const TITLE_TO_SLUG = { '+': 'plus', '.': 'dot', '&': 'and', đ: 'd', ħ: 'h', ı: 'i', ĸ: 'k', ŀ: 'l', ł: 'l', ß: 'ss', ŧ: 't' };
export function titleToSlug(title) {
  return title.toLowerCase()
    .replace(/[+.&đħıĸŀłßŧ]/g, (c) => TITLE_TO_SLUG[c])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function aliasHit(icon, wanted) {
  const aliases = [icon.title, ...(icon.aliases?.aka || []), ...(icon.aliases?.dup || []).map((d) => d.title), ...Object.values(icon.aliases?.loc || {})];
  return aliases.some((a) => wanted.has(normName(a))) || wanted.has(icon.slug);
}

/** Return matching Simple Icons entries: [{slug, title, hex, source, guidelines, license}] */
export async function findIcons(names, domain) {
  const data = await loadData();
  const icons = Array.isArray(data) ? data : data.icons;
  const wanted = new Set(names.filter(Boolean).map(normName));
  const matches = [];
  for (const icon of icons) {
    const slug = icon.slug || titleToSlug(icon.title);
    const aliases = [
      icon.title,
      ...(icon.aliases?.aka || []),
      ...(icon.aliases?.dup || []).map((d) => d.title),
      ...Object.values(icon.aliases?.loc || {}),
    ];
    const nameHit = aliases.some((a) => wanted.has(normName(a))) || wanted.has(slug);
    let byDomain = false;
    if (domain) {
      byDomain = [icon.source, icon.guidelines].some((u) => {
        const h = normDomain(u);
        return h && (h === domain || h.endsWith('.' + domain));
      });
    }
    if (nameHit || byDomain) matches.push({ ...icon, slug, exact: nameHit && normName(icon.title) === [...wanted][0], byDomain });
  }
  // Domain-only matches (icon source hosted on the company's site) are a fallback: a company's
  // site often hosts icons for its other products too.
  const byName = matches.filter((m) => aliasHit(m, wanted));
  const list = byName.length ? byName : matches;
  list.sort((a, b) => (b.exact - a.exact) || (b.byDomain - a.byDomain));
  return list.slice(0, 3);
}
