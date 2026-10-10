// Batch mode: look up many companies one after another (gently, to respect API rate limits) and ZIP the best sets.
/* global JSZip */
import { lookupCompany, collectAssets, buildBestSet } from './finder.js';
import { sleep } from './net.js';
import { canSvg, canPng, svgBlob, pngBlob, saveBlob, folderName, slugify, describeAsset } from './exports.js';

const MAX_LINES = 60;
const ROLES = ['original', 'dark', 'light'];

export function parseLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(.*?)\s*[,\t|]\s*([^\s,|]+\.[^\s,|]+)\s*$/.exec(line);
    const name = (m ? m[1] : line).trim();
    const domain = m ? m[2] : '';
    const key = `${name.toLowerCase()}|${domain.toLowerCase()}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, domain });
  }
  return out;
}

export function initBatch({ pngSize, h }) {
  const $ = (s) => document.querySelector(s);
  const runBtn = $('#batch-run');
  const stopBtn = $('#batch-stop');
  const zipBtn = $('#batch-zip');
  const list = $('#batch-list');
  let results = [];
  let cancelled = false;
  let thumbs = [];

  const status = (kind, title, detail) => {
    const el = $('#batch-status');
    el.className = `status ${kind}`;
    el.replaceChildren(h('div', { class: 'grow' }, h('div', { class: 'status-title' }, title), detail ? h('div', { class: 'small' }, detail) : null));
    el.hidden = false;
  };

  function rowFor(item) {
    const thumb = h('div', { class: 'thumb bg-checker' });
    const name = h('div', { class: 'name' }, item.name, item.domain ? h('span', { class: 'muted small' }, item.domain) : null);
    const badge = h('span', { class: 'badge' }, 'Queued');
    name.append(badge);
    const detail = h('div', { class: 'detail' }, '');
    const li = h('li', { class: 'batch-row' }, thumb, name, detail);
    list.append(li);
    return {
      set(kind, text, info) {
        badge.className = `badge ${kind}`;
        badge.textContent = text;
        if (info != null) detail.replaceChildren(...[].concat(info));
      },
      thumb(url) {
        thumb.replaceChildren(h('img', { src: url, alt: '' }));
      },
    };
  }

  async function processOne(item, row) {
    row.set('accent', 'Searching…');
    const { candidates, ambiguous, domain } = await lookupCompany(item.name, item.domain);
    const company = candidates[0] || null;
    const res = await collectAssets(company, { name: item.name, domain }, {
      progress: (msg) => row.set('accent', msg.length > 40 ? 'Downloading…' : msg),
      namedMax: 3, // only fetch Commons files explicitly named as dark/white variants
      otherMax: 0,
    });
    const best = res.assets.length ? await buildBestSet(res.assets) : null;

    // Free previews we won't show (only the original's thumbnail stays on screen).
    const keep = new Set(best ? ROLES.map((r) => best[r]?.displayUrl) : []);
    for (const a of res.assets) if (a.displayUrl?.startsWith('blob:') && !keep.has(a.displayUrl)) URL.revokeObjectURL(a.displayUrl);

    const sources = Object.entries(res.report).filter(([, r]) => r.status === 'ok' || r.status === 'partial').map(([k]) => k);
    const parts = [];
    parts.push(company ? `Matched ${company.label} (${company.id})` : 'Not on Wikidata');
    if (ambiguous) parts.push(`⚠ ambiguous — also: ${candidates.slice(1, 4).map((c) => c.label).join(', ')}; add a website to choose`);
    if (best) {
      parts.push(ROLES.map((r) => `${r}: ${!best[r] ? 'none' : best[r].generated ? 'generated' : best[r].source}`).join(' · '));
    }
    parts.push(`sources: ${sources.join(', ') || 'none'}`);
    const errors = Object.entries(res.report).filter(([, r]) => r.status === 'error');
    if (errors.length) parts.push(`errors: ${errors.map(([k, r]) => `${k}: ${r.text}`).join('; ')}`);

    if (!best) {
      row.set('err', errors.length && !sources.length ? 'Network error' : 'Nothing found', parts.join(' — '));
      return null;
    }
    if (best.original.displayUrl) {
      row.thumb(best.original.displayUrl);
      thumbs.push(...ROLES.map((r) => best[r]?.displayUrl).filter((u) => u?.startsWith('blob:')));
    }
    const lowOnly = best.original.source === 'favicon';
    row.set(lowOnly || ambiguous ? 'warn' : 'ok', lowOnly ? 'Site icon only' : ambiguous ? 'Found (check match)' : 'Found', parts.join(' — '));
    return { item, company, best, label: company?.label || item.name };
  }

  runBtn.addEventListener('click', async () => {
    const items = parseLines($('#batch-text').value);
    if (!items.length) {
      status('warn', 'Paste at least one company name', 'One per line. Optionally “Name, domain.com”.');
      return;
    }
    if (items.length > MAX_LINES) {
      status('warn', `Too many lines (${items.length})`, `Batch is limited to ${MAX_LINES} companies at a time to stay within the free APIs’ rate limits.`);
      return;
    }
    for (const u of thumbs) URL.revokeObjectURL(u);
    thumbs = [];
    results = [];
    cancelled = false;
    list.replaceChildren();
    runBtn.disabled = true;
    zipBtn.disabled = true;
    stopBtn.hidden = false;
    const rows = items.map(rowFor);
    let done = 0;
    for (let i = 0; i < items.length; i++) {
      if (cancelled) {
        rows.slice(i).forEach((r) => r.set('', 'Skipped'));
        break;
      }
      status('info', `Working… ${done}/${items.length}`, 'Companies are processed one at a time to avoid rate limits.');
      try {
        const r = await processOne(items[i], rows[i]);
        if (r) results.push(r);
      } catch (err) {
        rows[i].set('err', err.name === 'NetworkError' ? 'Network error' : 'Error', err.message);
      }
      done++;
      if (i < items.length - 1) await sleep(400);
    }
    stopBtn.hidden = true;
    runBtn.disabled = false;
    zipBtn.disabled = !results.length;
    const missing = items.length - results.length;
    status(results.length ? (missing ? 'warn' : 'info') : 'error',
      `${results.length} of ${items.length} companies have logos${cancelled ? ' (stopped early)' : ''}`,
      results.length ? 'Click “Download all as ZIP”.' : 'Nothing to download.');
  });

  stopBtn.addEventListener('click', () => {
    cancelled = true;
    stopBtn.hidden = true;
  });

  zipBtn.addEventListener('click', async () => {
    if (!window.JSZip) {
      status('error', 'ZIP library failed to load', 'JSZip couldn’t be loaded from cdnjs.cloudflare.com. Reload the page and try again.');
      return;
    }
    const size = pngSize();
    zipBtn.disabled = true;
    const zip = new JSZip();
    const used = new Set();
    try {
      for (let i = 0; i < results.length; i++) {
        const { company, best, label, item } = results[i];
        status('info', `Building ZIP… ${i + 1}/${results.length}`, label);
        let folder = folderName(label);
        for (let n = 2; used.has(folder.toLowerCase()); n++) folder = `${folderName(label)} (${n})`;
        used.add(folder.toLowerCase());
        const base = slugify(label);
        const lines = [
          `Company: ${label}${company ? ` — Wikidata ${company.id} https://www.wikidata.org/wiki/${company.id}` : ' (not found on Wikidata)'}`,
          `Searched as: ${item.name}${item.domain ? `, ${item.domain}` : ''}`,
          '',
        ];
        for (const role of ROLES) {
          const a = best[role];
          lines.push(`${role}: ${describeAsset(a)}`);
          if (!a) continue;
          const name = `${base}-${role}${a.generated ? '-generated' : ''}`;
          if (canSvg(a)) zip.file(`${folder}/${role}/${name}.svg`, svgBlob(a));
          if (canPng(a)) zip.file(`${folder}/${role}/${name}-${size}.png`, await pngBlob(a, size));
        }
        lines.push('', 'Logos are trademarks of their respective owners. Check the licence and brand guidelines before use.');
        zip.file(`${folder}/SOURCES.txt`, lines.join('\n'));
      }
      status('info', 'Compressing…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      saveBlob(blob, `logos-${new Date().toISOString().slice(0, 10)}.zip`);
      status('info', 'ZIP ready', `${results.length} companies, PNGs at ${size}px on the long edge.`);
    } catch (err) {
      status('error', 'Could not build the ZIP', err.message);
    } finally {
      zipBtn.disabled = false;
    }
  });
}
