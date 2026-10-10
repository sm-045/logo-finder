// Orchestration: company lookup → collect logos from all sources → rank, dedupe → best original/dark/light set.
import { findCompanies, normDomain } from './wikidata.js';
import { fileInfo, findVariants, commonsFile } from './commons.js';

const USABLE_MIME = new Set(['image/svg+xml', 'image/png', 'image/webp']);
import { findIcons, iconUrl } from './simpleicons.js';
import { findFavicon } from './favicon.js';
import { findPageImage } from './wikipedia.js';
import { fetchWithRetry } from './net.js';
import {
  prepareSvg, setSvgFill, svgBlobUrl, loadImage, analyze, sha256, buildRecoloredSvg, suggestMode,
} from './imaging.js';

export const SOURCE_LABELS = {
  wikidata: 'Wikidata (P154 logo)',
  'wikidata-icon': 'Wikidata (icon)',
  commons: 'Wikimedia Commons',
  wikipedia: 'Wikipedia (infobox)',
  simpleicons: 'Simple Icons',
  favicon: 'Site icon',
};

export async function lookupCompany(name, domainInput) {
  const domain = normDomain(domainInput);
  const { candidates, ambiguous } = await findCompanies(name.trim(), domain);
  return { candidates, ambiguous, domain };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { error: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function rankOf(a) {
  let r;
  if (a.historical) r = 3.5;
  else if (a.source === 'wikidata') r = a.preferred ? 0 : 0.1;
  else if (a.source === 'commons' && !a.isIcon) r = a.hint ? 1 : 1.5;
  else if (a.source === 'wikipedia') r = 1.8;
  else if (a.source === 'wikidata-icon') r = 2;
  else if (a.source === 'commons') r = 2.3;
  else if (a.source === 'simpleicons') r = 2.6;
  else r = 4; // favicon
  if (a.analysis && a.analysis.transparency.status !== 'ok') r += 0.45;
  r += (a.extraWords || 0) * 0.1;
  return r;
}

/** Download a file and turn it into a displayable, analysed asset. */
async function materialize(meta) {
  const blob = meta.blob || await fetchWithRetry(meta.fileUrl, { as: 'blob', timeout: 20000, retries: 2 });
  const isSvg = /svg/.test(blob.type) || meta.mime === 'image/svg+xml' || /\.svg(\?|$)/i.test(meta.fileUrl);
  const a = { ...meta, blob };
  let bgRect = false;
  if (isSvg) {
    const p = prepareSvg(await blob.text());
    a.kind = 'vector';
    a.rawSvg = p.svgText;
    a.svgText = meta.fill ? setSvgFill(p.svgText, meta.fill) : p.svgText;
    a.width = p.width;
    a.height = p.height;
    a.displayUrl = svgBlobUrl(a.svgText);
    bgRect = p.bgRect;
  } else {
    a.kind = 'raster';
    a.displayUrl = URL.createObjectURL(blob);
    const img = await loadImage(a.displayUrl);
    a.width = img.naturalWidth;
    a.height = img.naturalHeight;
  }
  try {
    a.analysis = await analyze(a.displayUrl, a.width, a.height);
  } catch {
    a.analysis = { transparency: { status: 'unknown', label: 'Could not check' }, tone: 'color' };
  }
  if (bgRect) a.analysis.transparency = { status: 'background', label: 'Background rectangle' };
  a.hash = await sha256(a.svgText || blob);
  return a;
}

/**
 * Collect every logo we can find for a company. Downloads happen in two phases so the official
 * logo can be shown quickly while Commons variants (rate-limited host) trickle in.
 * @param {object|null} company  Wikidata candidate (or null when nothing matched)
 * @param {{name: string, domain: string}} input
 * @param {{progress?: (msg: string) => void, onPartial?: (r: object) => (void|Promise<void>), namedMax?: number, otherMax?: number}} [opts]
 *   namedMax/otherMax cap how many Commons extras are downloaded (files named dark/white/etc. vs. other logo files).
 */
export async function collectAssets(company, { name, domain }, opts = {}) {
  const { progress = () => {}, onPartial = null, namedMax = 4, otherMax = 2 } = opts;
  const names = [...new Set([company?.label, name].filter(Boolean))];
  const siteDomain = domain || normDomain(company?.website);
  const report = {};
  const phase1 = [];
  const phase2 = [];
  const have = new Set();

  progress('Looking up logo files…');

  // Wikidata logos: file URLs are computed locally, so the official logo doesn't wait on the Commons API.
  // Licence/author metadata is fetched alongside and filled in when it arrives.
  const wdLogos = [];
  if (company) {
    let historicalCount = 0;
    for (const [list, source] of [[company.logos, 'wikidata'], [company.icons, 'wikidata-icon']]) {
      for (const l of list) {
        const f = commonsFile(l.file);
        if (have.has(f.title) || !USABLE_MIME.has(f.mime)) continue; // JPEG etc. can't be transparent
        if (l.historical && ++historicalCount > 1) continue;
        have.add(f.title);
        const meta = {
          source, title: f.title, fileUrl: f.url, pageUrl: f.pageUrl, license: 'See file page', author: '',
          mime: f.mime, preferred: l.preferred, historical: l.historical, scheme: l.scheme, isIcon: source === 'wikidata-icon',
        };
        wdLogos.push(meta);
        (source === 'wikidata' && !l.historical ? phase1 : phase2).push(meta);
      }
    }
    report.wikidata = wdLogos.length
      ? { status: 'ok', text: `${company.logos.length} logo + ${company.icons.length} icon file(s) listed` }
      : { status: 'none', text: company.logos.length ? 'Listed logo files are JPEG/unsupported' : 'Entity found, but no logo (P154) listed' };
  } else {
    report.wikidata = { status: 'none', text: 'No matching company on Wikidata' };
  }

  // Wikipedia's infobox image only matters when Wikidata has no current logo.
  const needWikipedia = Boolean(company?.enwiki && !phase1.length);
  const mainFile = company?.logos.find((l) => !l.historical)?.file || company?.logos[0]?.file || null;

  const metaP = wdLogos.length ? fileInfo(wdLogos.map((m) => m.title)).catch(() => null) : Promise.resolve(null);
  const variantsP = findVariants(names, mainFile).then((v) => ({ ok: v }), (e) => ({ err: e }));
  const [icons, favicon, wpImage] = await Promise.allSettled([
    findIcons(names, siteDomain),
    siteDomain ? findFavicon(siteDomain) : Promise.resolve(null),
    needWikipedia ? findPageImage(company.enwiki, names) : Promise.resolve(null),
  ]);

  // English Wikipedia infobox logo (often non-free, so not on Commons / Wikidata)
  if (needWikipedia) {
    if (wpImage.status === 'rejected') report.wikipedia = { status: 'error', text: wpImage.reason.message };
    else if (!wpImage.value || have.has(wpImage.value.title)) report.wikipedia = { status: 'none', text: 'No logo in the article infobox' };
    else {
      const w = wpImage.value;
      have.add(w.title);
      phase1.push({ source: 'wikipedia', title: w.title, fileUrl: w.url, pageUrl: w.pageUrl, license: w.license, author: w.author, mime: w.mime });
      report.wikipedia = { status: 'ok', text: w.title.replace(/^File:/, '') };
    }
  }

  // Simple Icons
  if (icons.status === 'rejected') report.simpleicons = { status: 'error', text: icons.reason.message };
  else if (!icons.value.length) report.simpleicons = { status: 'none', text: 'No icon' };
  else {
    for (const ic of icons.value) {
      phase1.push({
        source: 'simpleicons', title: `${ic.title} (Simple Icons)`, fileUrl: iconUrl(ic.slug),
        pageUrl: `https://simpleicons.org/?q=${encodeURIComponent(ic.slug)}`,
        license: ic.license?.type ? `${ic.license.type} (per Simple Icons)` : 'CC0 icon data; trademark of owner',
        author: ic.source ? `Source: ${ic.source}` : '', mime: 'image/svg+xml', isIcon: true, fill: `#${ic.hex}`, hex: ic.hex, slug: ic.slug,
      });
    }
    report.simpleicons = { status: 'ok', text: icons.value.map((i) => `${i.slug} #${i.hex}`).join(', ') };
  }

  // Favicon
  if (!siteDomain) report.favicon = { status: 'none', text: 'No domain known' };
  else if (favicon.status === 'rejected' || !favicon.value) report.favicon = { status: 'error', text: 'Lookup failed' };
  else {
    const f = favicon.value;
    phase1.push({
      source: 'favicon', title: `${siteDomain} site icon`, fileUrl: f.url, pageUrl: `https://${siteDomain}/`,
      license: 'Trademark of owner — low quality', author: `via ${f.via}`, blob: f.blob, displayOnly: f.displayOnly, lowQuality: true, isIcon: true,
    });
    report.favicon = { status: f.displayOnly ? 'partial' : 'ok', text: f.displayOnly ? `${f.via} (preview only)` : `via ${f.via}` };
  }

  const seenHash = new Set();
  const assets = [];
  const failedMetas = [];
  let counter = 0;
  const run = async (metas) => {
    const results = await pool(metas, 3, async (m) => {
      if (m.displayOnly) {
        return { ...m, kind: 'raster', width: 128, height: 128, displayUrl: m.fileUrl, analysis: null, hash: m.fileUrl };
      }
      return materialize(m);
    });
    results.forEach((r, i) => {
      if (r?.error) {
        failedMetas.push(metas[i]);
        console.warn(`Logo Finder: skipped ${metas[i].title}: ${r.error.message}`);
      } else if (r && !seenHash.has(r.hash)) {
        seenHash.add(r.hash);
        assets.push({ ...r, id: `a${counter++}`, rank: rankOf(r) });
      } else if (r?.displayUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(r.displayUrl); // exact duplicate of something we already have
      }
    });
    assets.sort((a, b) => a.rank - b.rank);
  };
  const applyMeta = (info) => {
    if (!info) return;
    for (const a of assets) {
      const m = info.get(a.title.replace(/^File:/, '')) || info.get(a.title);
      if (m && (a.source === 'wikidata' || a.source === 'wikidata-icon')) {
        a.license = m.license;
        a.author = m.author;
        a.pageUrl = m.pageUrl || a.pageUrl;
      }
    }
  };

  progress(`Downloading ${phase1.length} file(s)…`);
  await run(phase1);
  if (onPartial && assets.length) {
    applyMeta(await Promise.race([metaP, new Promise((r) => setTimeout(() => r(null), 1500))]));
    await onPartial({ assets: [...assets], report, failures: failedMetas.length, domain: siteDomain, pending: true });
  }

  // Phase 2: Commons variants, Wikidata icons, one historical logo.
  progress('Searching Wikimedia Commons for dark / light variants…');
  const variants = await variantsP;
  if (variants.err) report.commons = { status: 'error', text: variants.err.message };
  else {
    // upload.wikimedia.org only allows a download every few seconds, so be picky about which extras we fetch.
    const score = (v) => v.extraWords * 0.6 + v.isIcon * 0.4 + (v.mime === 'image/svg+xml' ? 0 : 0.3);
    const fresh = variants.ok.filter((v) => !have.has(v.title) && !v.historical).sort((a, b) => score(a) - score(b));
    const extra = [
      ...fresh.filter((v) => v.hint).slice(0, namedMax),
      ...fresh.filter((v) => !v.hint).slice(0, otherMax),
    ];
    for (const v of extra) {
      phase2.push({
        source: 'commons', title: v.title, fileUrl: v.url, pageUrl: v.pageUrl, license: v.license, author: v.author,
        mime: v.mime, hint: v.hint, isIcon: v.isIcon, historical: v.historical, extraWords: v.extraWords,
      });
    }
    report.commons = extra.length ? { status: 'ok', text: `${extra.length} extra file(s)` } : { status: 'none', text: 'No extra variants' };
  }
  if (phase2.length) {
    progress(`Checking ${phase2.length} more file(s) on Wikimedia Commons…`);
    await run(phase2);
  }
  applyMeta(await metaP);
  return { assets, report, failures: failedMetas.length, domain: siteDomain, pending: false };
}

/* ------------------------------------------------------------ best set ---- */

const usable = (a) => !a.displayOnly && a.analysis?.transparency.status === 'ok';
const aspect = (a) => a.width / a.height;
const sameFamily = (a, b) => {
  const r = aspect(a) / aspect(b);
  return r > 0.75 && r < 1.33 && Boolean(a.isIcon) === Boolean(b.isIcon);
};

export function choosePrimary(assets) {
  const pool = assets.filter((a) => a.source !== 'favicon');
  const ok = pool.filter((a) => usable(a) && !a.historical);
  const pick = ok.find((a) => a.source === 'wikidata' && a.analysis.tone === 'color' && !a.scheme)
    || ok.find((a) => a.source === 'wikidata')
    || ok.find((a) => a.source === 'wikipedia')
    || ok.find((a) => a.analysis.tone === 'color' && !a.hint)
    || ok[0]
    || pool.find((a) => !a.displayOnly)
    || assets.find((a) => !a.displayOnly)
    || null;
  // Prefer a vector copy of the same logo (same shape and tone) over a raster official file.
  if (pick?.kind === 'raster' && pick.source !== 'favicon') {
    const vector = ok.find((a) => a.kind === 'vector' && !a.hint && a.source !== 'simpleicons' &&
      sameFamily(a, pick) && a.analysis.tone === pick.analysis?.tone);
    if (vector) return { ...vector, vectorOf: pick };
  }
  return pick;
}

export async function makeGenerated(base, role, mode) {
  const color = role === 'dark' ? '#000000' : '#FFFFFF';
  const svgText = await buildRecoloredSvg(base, color, mode);
  return {
    id: `${base.id}-${role}-gen`, generated: true, base, role, mode, color,
    kind: base.kind, svgText, width: base.width, height: base.height, displayUrl: svgBlobUrl(svgText),
    title: `${base.title} → ${role === 'dark' ? 'black' : 'white'}`, source: 'generated',
  };
}

function monoFromSimpleIcon(si, role) {
  const color = role === 'dark' ? '#000000' : '#FFFFFF';
  const svgText = setSvgFill(si.rawSvg, color);
  return {
    ...si, id: `${si.id}-${role}`, svgText, displayUrl: svgBlobUrl(svgText), blob: null,
    analysis: { ...si.analysis, tone: role }, title: `${si.title.replace(/ \(Simple Icons\)$/, '')} mono ${role === 'dark' ? 'black' : 'white'} (Simple Icons)`,
  };
}

/**
 * Pick original / dark / light. Real variants are preferred; otherwise recoloured versions are generated.
 * @returns {Promise<{original: object, dark: object, light: object, mode: string} | null>}
 */
export async function buildBestSet(assets, overrides = {}, mode) {
  const primary = overrides.original || choosePrimary(assets);
  if (!primary) return null;
  const recolorMode = mode || suggestMode(primary.analysis);

  const findReal = (tone) => {
    if (overrides[tone]) return overrides[tone];
    if (primary.analysis?.tone === tone) return primary;
    if (primary.source === 'simpleicons') return monoFromSimpleIcon(primary, tone);
    const pref = (a) => (a.scheme === tone || a.hint === tone ? 0 : 1) + (a.source === 'wikidata' ? 0 : 0.5) + a.rank / 10;
    return assets
      .filter((a) => a !== primary && usable(a) && !a.historical && a.source !== 'favicon' && a.source !== 'simpleicons' &&
        a.analysis.tone === tone && sameFamily(a, primary))
      .sort((a, b) => pref(a) - pref(b))[0] || null;
  };

  // A silhouette of an image with a solid background is just a filled rectangle, so don't generate one.
  const status = primary.analysis?.transparency.status;
  const canGenerate = !primary.displayOnly && (status === 'ok' || status === 'unknown');
  const out = { original: primary, mode: recolorMode, reason: null };
  for (const tone of ['dark', 'light']) {
    out[tone] = findReal(tone) || (canGenerate ? await makeGenerated(primary, tone, recolorMode) : null);
  }
  if (!canGenerate && (!out.dark || !out.light)) {
    out.reason = primary.displayOnly
      ? 'Can’t recolour a preview-only image.'
      : 'Can’t generate this variant: the original has a solid background, so recolouring would give a filled rectangle. Pick another result with “Use as…”.';
  }
  return out;
}
