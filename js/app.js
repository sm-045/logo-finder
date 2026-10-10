import { lookupCompany, collectAssets, buildBestSet, SOURCE_LABELS } from './finder.js';
import { RECOLOR_MODES } from './imaging.js';
import { NetworkError } from './net.js';
import { canSvg, canPng, svgBlob, pngBlob, saveBlob, slugify } from './exports.js';
import { initBatch } from './batch.js';

const $ = (sel) => document.querySelector(sel);

/** Tiny element builder. Text children are always inserted as text, never HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const state = {
  token: 0,
  name: '',
  domain: '',
  candidates: [],
  company: null,
  assets: [],
  best: null,
  overrides: {},
  mode: null,
  blobUrls: new Set(),
};

export const pngSize = () => Number(document.querySelector('input[name="png-size"]:checked')?.value || 1024);

/* --------------------------------------------------------------- status ---- */

function showStatus(kind, title, detail, { spinner = false, action = null } = {}) {
  const el = $('#status');
  el.className = `status ${kind}`;
  el.replaceChildren(...[
    spinner ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
    h('div', { class: 'grow' }, h('div', { class: 'status-title' }, title), detail ? h('div', { class: 'small' }, detail) : null),
    action,
  ].filter(Boolean));
  el.hidden = false;
}

const hideStatus = () => { $('#status').hidden = true; };

function showError(err, retry) {
  if (err instanceof NetworkError) {
    showStatus('error', 'Network error', `${err.message}. ${err.status === 429 ? 'Wait a minute and try again.' : 'Check your connection (or any ad/content blocker) and try again.'}`,
      { action: retry ? h('button', { class: 'btn small', type: 'button', onclick: retry }, 'Retry') : null });
  } else {
    console.error(err);
    showStatus('error', 'Something went wrong', err?.message || String(err),
      { action: retry ? h('button', { class: 'btn small', type: 'button', onclick: retry }, 'Retry') : null });
  }
}

/* ------------------------------------------------------------- reset ------ */

function trackUrls(assets) {
  for (const a of assets) if (a?.displayUrl?.startsWith('blob:')) state.blobUrls.add(a.displayUrl);
}

function revokeAll() {
  for (const u of state.blobUrls) URL.revokeObjectURL(u);
  state.blobUrls.clear();
}

function clearResults() {
  revokeAll();
  state.assets = [];
  state.best = null;
  for (const id of ['#best-section', '#all-section', '#sources-section', '#company']) $(id).hidden = true;
  $('#best').replaceChildren();
  $('#all').replaceChildren();
  $('#sources').replaceChildren();
}

function setBusy(busy) {
  $('#search-btn').disabled = busy;
  $('#search-btn').textContent = busy ? 'Searching…' : 'Find logos';
}

/* --------------------------------------------------------------- search ---- */

async function run(name, domainRaw) {
  const token = ++state.token;
  clearResults();
  $('#picker').hidden = true;
  $('#empty-hint').hidden = true;
  setBusy(true);
  showStatus('info', 'Searching Wikidata…', null, { spinner: true });
  updateUrl(name, domainRaw);
  try {
    const { candidates, ambiguous, domain } = await lookupCompany(name, domainRaw);
    if (token !== state.token) return;
    Object.assign(state, { name: name || domain, domain, candidates });
    if (domainRaw && !domain) {
      showStatus('warn', 'That website doesn’t look valid', 'Use a domain like “stripe.com”.');
      return;
    }
    if (!candidates.length) {
      await loadCompany(null, token, `No company called “${name || domain}” found on Wikidata`);
      return;
    }
    renderPicker(candidates, ambiguous, candidates[0]);
    await loadCompany(candidates[0], token);
  } catch (err) {
    if (token === state.token) showError(err, () => run(name, domainRaw));
  } finally {
    if (token === state.token) setBusy(false);
  }
}

async function choose(candidate) {
  const token = ++state.token;
  setBusy(true);
  for (const b of document.querySelectorAll('#picker .chip')) b.setAttribute('aria-pressed', String(b.dataset.id === (candidate?.id || 'none')));
  try {
    await loadCompany(candidate, token, candidate ? null : 'Skipping Wikidata');
  } catch (err) {
    if (token === state.token) showError(err, () => choose(candidate));
  } finally {
    if (token === state.token) setBusy(false);
  }
}

async function loadCompany(company, token, note = null) {
  clearResults();
  state.company = company;
  state.overrides = {};
  state.mode = null;
  renderCompany(company);
  showStatus('info', note ? `${note}. Checking other sources…` : `Finding logos for ${company.label}…`, null, { spinner: true });

  const show = async (r) => {
    state.assets = r.assets;
    trackUrls(r.assets);
    renderSources(r.report);
    if (r.assets.length) {
      await refreshBest();
      renderAll();
    }
  };
  const res = await collectAssets(company, { name: state.name, domain: state.domain }, {
    progress: (msg) => {
      if (token === state.token) showStatus('info', msg, state.assets.length ? 'Wikimedia only allows a file download every few seconds, so variants appear gradually.' : null, { spinner: true });
    },
    onPartial: async (partial) => {
      if (token === state.token) await show(partial);
    },
  });
  if (token !== state.token) return;
  await show(res);
  if (token !== state.token) return;
  const reports = Object.values(res.report);
  if (!res.assets.length) {
    const label = company?.label || state.name;
    if (res.failures) {
      showStatus('error', 'Logos were found but couldn’t be downloaded', `${res.failures} file(s) failed — Wikimedia is probably rate-limiting this network. Wait a minute and retry.`,
        { action: h('button', { class: 'btn small', type: 'button', onclick: () => choose(company) }, 'Retry') });
    } else if (reports.some((r) => r.status === 'error') && !reports.some((r) => r.status === 'ok')) {
      const err = reports.find((r) => r.status === 'error');
      showError(new NetworkError(err.text), () => choose(company));
    } else {
      showStatus('warn', `No logos found for “${label}”`,
        state.domain ? 'Check the spelling or try the company’s full legal name.' : 'Check the spelling, try the full legal name, or add the company’s website so we can at least fetch its site icon.');
    }
    return;
  }

  const problems = [];
  if (res.failures) problems.push(`${res.failures} file(s) could not be downloaded (Wikimedia may be rate-limiting — wait a moment and retry).`);
  const errs = Object.entries(res.report).filter(([, r]) => r.status === 'error');
  if (errs.length) problems.push(`Some sources failed: ${errs.map(([k, r]) => `${SOURCE_LABELS[k] || k} (${r.text})`).join('; ')}.`);
  const retry = problems.length ? h('button', { class: 'btn small', type: 'button', onclick: () => choose(company) }, 'Retry') : null;
  const onlyLow = res.assets.every((a) => a.source === 'favicon');
  if (onlyLow && res.failures) showStatus('warn', 'Logos were found but couldn’t be downloaded', problems.join(' '), { action: retry });
  else if (onlyLow) showStatus('warn', 'Only a low-quality site icon was found', 'No proper logo for this company exists in the open sources. ' + problems.join(' '), { action: retry });
  else if (problems.length) showStatus('warn', 'Partial results', problems.join(' '), { action: retry });
  else hideStatus();
}

async function refreshBest() {
  state.best = await buildBestSet(state.assets, state.overrides, state.mode);
  if (!state.best) return;
  state.mode = state.best.mode;
  trackUrls([state.best.dark, state.best.light]);
  renderBest();
}

/* ------------------------------------------------------------- rendering ---- */

function renderPicker(candidates, ambiguous, selected) {
  const el = $('#picker');
  if (!ambiguous && candidates.length < 2) {
    el.hidden = true;
    return;
  }
  const chips = candidates.slice(0, 8).map((c) => h('button', {
    class: 'chip', type: 'button', 'data-id': c.id, 'aria-pressed': String(c === selected), onclick: () => choose(c),
  }, h('b', {}, c.label), h('small', {}, [c.description || c.id, c.website ? ` · ${hostOf(c.website)}` : ''].join(''))));
  chips.push(h('button', { class: 'chip', type: 'button', 'data-id': 'none', 'aria-pressed': 'false', onclick: () => choose(null) },
    h('b', {}, 'None of these'), h('small', {}, 'Use Simple Icons / site icon only')));
  el.replaceChildren(
    h('p', {}, ambiguous
      ? h('span', {}, h('b', {}, 'More than one company matches. '), 'Showing the most likely one. Pick another if it’s wrong, or add the website to be precise:')
      : h('span', {}, 'Other matches:')),
    h('div', { class: 'chips' }, chips),
  );
  el.hidden = false;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function renderCompany(c) {
  const el = $('#company');
  if (!c) {
    el.replaceChildren(h('h2', {}, state.name), h('span', { class: 'desc' }, 'Not found on Wikidata'));
  } else {
    el.replaceChildren(
      h('h2', {}, c.label),
      c.description ? h('span', { class: 'desc' }, c.description) : null,
      h('span', { class: 'links' },
        h('a', { href: c.url, target: '_blank', rel: 'noopener' }, `Wikidata ${c.id}`),
        c.website ? h('a', { href: c.website, target: '_blank', rel: 'noopener noreferrer' }, hostOf(c.website)) : null),
    );
  }
  el.hidden = false;
}

const ROLE_TITLES = {
  original: 'Original / brand colour',
  dark: 'Dark · for light backgrounds',
  light: 'Light · for dark backgrounds',
};

function badgesFor(a, role) {
  const b = [];
  if (a.generated) b.push(['Generated', 'accent']);
  else b.push([SOURCE_LABELS[a.source] || a.source, a.source === 'favicon' ? 'warn' : '']);
  if (role && role !== 'original' && state.best?.original === a) b.push(['Same as original', '']);
  if (a.vectorOf) b.push(['Vector copy of official PNG', 'ok']);
  if (a.scheme) b.push([a.scheme === 'dark' ? 'Marked for light bg' : 'Marked for dark bg', 'ok']);
  else if (a.hint && !a.generated) b.push([`Named “${a.hint}”`, '']);
  if (a.historical) b.push(['Historical', 'warn']);
  if (a.lowQuality) b.push(['Low quality', 'warn']);
  if (a.displayOnly) b.push(['Preview only', 'warn']);
  const t = (a.generated && !a.analysis ? a.base.analysis : a.analysis)?.transparency;
  if (t) b.push([t.label, t.status === 'ok' ? 'ok' : t.status === 'unknown' ? '' : 'err']);
  if (a.kind === 'raster' && !a.displayOnly && !a.generated) b.push(['Raster', '']);
  return b;
}

function card(a, { role = null, onUse = null } = {}) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const title = node.querySelector('.card-title');
  if (role) title.append(h('span', { class: 'role' }, ROLE_TITLES[role]));
  title.append(a.generated ? `Recoloured ${a.color === '#000000' ? 'black' : 'white'}` : a.title.replace(/^File:/, ''));
  node.querySelector('.badges').append(...badgesFor(a, role).map(([t, k]) => h('span', { class: `badge ${k}` }, t)));

  for (const img of node.querySelectorAll('.previews img')) {
    img.src = a.displayUrl;
    img.alt = `${a.title} preview`;
    img.loading = 'lazy';
    if (a.displayOnly) img.referrerPolicy = 'no-referrer';
  }

  const meta = node.querySelector('.meta');
  const row = (k, v) => meta.append(h('dt', {}, k), h('dd', {}, v));
  if (a.generated) {
    row('From', h('a', { href: a.base.pageUrl || a.base.fileUrl, target: '_blank', rel: 'noopener noreferrer' }, a.base.title.replace(/^File:/, '')));
    row('Method', `${RECOLOR_MODES[a.mode]} (SVG filter)`);
    row('Licence', a.base.license || '—');
  } else {
    row('Source', h('a', { href: a.pageUrl || a.fileUrl, target: '_blank', rel: 'noopener noreferrer' }, a.source === 'favicon' ? a.author : 'File page'));
    row('Licence', a.license || '—');
    if (a.author && a.source !== 'favicon') row('Author', a.author);
  }
  const fmt = a.displayOnly ? 'image' : a.kind === 'vector' ? 'SVG' : (a.blob?.type || 'raster').replace('image/', '').toUpperCase();
  row('Size', `${Math.round(a.width)}×${Math.round(a.height)} · ${a.generated ? (a.kind === 'vector' ? 'SVG' : 'bitmap') : fmt}`);

  const actions = node.querySelector('.actions');
  const base = `${slugify(state.company?.label || state.name)}-${role || slugify(a.title)}${a.generated ? '-generated' : ''}`;
  if (canSvg(a)) {
    actions.append(h('button', { class: 'btn small', type: 'button', onclick: () => saveBlob(svgBlob(a), `${base}.svg`) }, 'SVG'));
  }
  if (canPng(a)) {
    const btn = h('button', { class: 'btn small', type: 'button' }, 'PNG');
    btn.addEventListener('click', async () => {
      const size = pngSize();
      btn.disabled = true;
      try {
        saveBlob(await pngBlob(a, size), `${base}-${size}.png`);
      } catch (e) {
        showError(e);
      } finally {
        btn.disabled = false;
      }
    });
    actions.append(btn);
    if (a.kind === 'raster' && Math.max(a.width, a.height) < pngSize()) {
      actions.append(h('span', { class: 'muted small' }, `upscaled from ${Math.max(a.width, a.height)}px`));
    }
  }
  if (a.displayOnly) {
    actions.append(h('a', { class: 'btn small', href: a.fileUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open image'));
  }
  if (onUse) {
    const sel = h('select', { 'aria-label': 'Use this logo as' },
      h('option', { value: '' }, 'Use as…'),
      h('option', { value: 'original' }, 'Original'),
      h('option', { value: 'dark' }, 'Dark'),
      h('option', { value: 'light' }, 'Light'));
    sel.addEventListener('change', () => sel.value && onUse(sel.value));
    actions.append(sel);
  }
  return node;
}

function renderBest() {
  const { best } = state;
  $('#best').replaceChildren(...['original', 'dark', 'light'].map((role) => {
    const a = best[role];
    if (a) return card(a, { role });
    return h('article', { class: 'card' }, h('h3', { class: 'card-title' }, h('span', { class: 'role' }, ROLE_TITLES[role]), 'Not available'),
      h('p', { class: 'muted small' }, best.reason || 'Not available.'));
  }));

  const anyGenerated = best.dark?.generated || best.light?.generated || Boolean(best.reason && !best.original.displayOnly);
  const sel = $('#mode-select');
  sel.replaceChildren(...Object.entries(RECOLOR_MODES).map(([k, v]) => h('option', { value: k, selected: k === state.mode }, v)));
  $('#mode-wrap').hidden = !anyGenerated;
  $('#best-section').hidden = false;
}

function renderAll() {
  const list = state.assets;
  $('#all-count').textContent = `(${list.length})`;
  $('#all').replaceChildren(...list.map((a) => card(a, {
    onUse: async (role) => {
      state.overrides[role] = a;
      if (role === 'original') { delete state.overrides.dark; delete state.overrides.light; }
      await refreshBest();
      $('#best-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  })));
  $('#all-section').hidden = false;
}

function renderSources(report) {
  const icon = { ok: '✓', partial: '◐', none: '–', error: '✕' };
  const names = { wikidata: 'Wikidata', wikipedia: 'Wikipedia infobox', commons: 'Wikimedia Commons', simpleicons: 'Simple Icons', favicon: 'Site icon' };
  $('#sources').replaceChildren(...Object.entries(report).map(([k, r]) => h('li', {},
    h('span', { class: 'src-name' }, `${icon[r.status] || ''} ${names[k] || k}`),
    h('span', { class: r.status === 'error' ? 'badge err' : 'muted' }, r.text))));
  $('#sources-section').hidden = false;
}

/* ---------------------------------------------------------------- wiring ---- */

function updateUrl(name, domain) {
  const u = new URL(location.href);
  u.search = '';
  if (name) u.searchParams.set('q', name);
  if (domain) u.searchParams.set('domain', domain);
  history.replaceState(null, '', u);
}

function initTheme() {
  const root = document.documentElement;
  $('#theme-toggle').addEventListener('click', () => {
    const current = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('logo-finder-theme', next); } catch { /* ignore */ }
  });
}

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        select(next);
        next.focus();
      }
    });
  });
  if (new URL(location.href).searchParams.get('mode') === 'batch') select(tabs[1]);
}

function init() {
  initTheme();
  initTabs();
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#q-name').value.trim();
    const domain = $('#q-domain').value.trim();
    if (!name && !domain) {
      showStatus('warn', 'Enter a company name', 'Optionally add its website to tell similar names apart.');
      $('#q-name').focus();
      return;
    }
    run(name, domain);
  });
  $('#mode-select').addEventListener('change', async (e) => {
    state.mode = e.target.value;
    await refreshBest();
  });
  for (const r of document.querySelectorAll('input[name="png-size"]')) {
    r.addEventListener('change', () => {
      $('#batch-size').textContent = String(pngSize());
      if (state.best) { renderBest(); renderAll(); }
    });
  }
  initBatch({ pngSize, h });

  const params = new URL(location.href).searchParams;
  const q = params.get('q');
  const d = params.get('domain');
  if (q || d) {
    $('#q-name').value = q || '';
    $('#q-domain').value = d || '';
    run(q || '', d || '');
  }
}

function waitForLibs() {
  if (window.DOMPurify) return init();
  // Deferred CDN scripts run before module scripts, so a missing DOMPurify means the CDN was blocked.
  window.addEventListener('load', () => {
    if (window.DOMPurify) init();
    else {
      init();
      showStatus('error', 'Couldn’t load a required library', 'DOMPurify failed to load from cdnjs.cloudflare.com, so SVGs can’t be processed safely. Check your connection or content blocker and reload.');
      $('#search-btn').disabled = true;
    }
  }, { once: true });
}

waitForLibs();
