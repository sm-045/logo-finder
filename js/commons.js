// Wikimedia Commons: file metadata (URL, licence, author) and searches for extra logo variants.
import { mwApi } from './net.js';
import { normName } from './wikidata.js';
import { md5 } from './md5.js';

const COMMONS = 'https://commons.wikimedia.org/w/api.php';

/** Direct file URL + file page for a Commons file name, computed locally (no API call). */
export function commonsFile(name) {
  let n = name.replace(/^File:/, '').trim().replace(/ /g, '_');
  n = n.charAt(0).toUpperCase() + n.slice(1); // MediaWiki capitalises the first letter
  const h = md5(n);
  const ext = n.split('.').pop().toLowerCase();
  return {
    title: `File:${n.replace(/_/g, ' ')}`,
    url: `https://upload.wikimedia.org/wikipedia/commons/${h[0]}/${h.slice(0, 2)}/${encodeURIComponent(n)}`,
    pageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(n)}`,
    mime: { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[ext] || 'application/octet-stream',
  };
}

const ALLOWED_MIME = new Set(['image/svg+xml', 'image/png', 'image/webp']);

const stripHtml = (s) => {
  if (!s) return '';
  const d = new DOMParser().parseFromString(String(s), 'text/html');
  return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
};

function toFileInfo(page) {
  const ii = page.imageinfo?.[0];
  if (!ii) return null;
  const meta = ii.extmetadata || {};
  return {
    title: page.title,
    url: ii.url.split('?')[0], // drop utm_* params so the CDN cache (and ours) is shared
    pageUrl: ii.descriptionurl,
    mime: ii.mime,
    width: ii.width,
    height: ii.height,
    license: stripHtml(meta.LicenseShortName?.value) || 'See file page',
    licenseUrl: meta.LicenseUrl?.value || null,
    author: stripHtml(meta.Artist?.value).slice(0, 120),
  };
}

const IIPROPS = {
  prop: 'imageinfo',
  iiprop: 'url|mime|size|extmetadata',
  iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist',
};

/** Look up several Commons files by name ("Foo.svg" or "File:Foo.svg"). Returns Map<inputName, info>. */
export async function fileInfo(names) {
  const out = new Map();
  const titles = names.map((n) => (n.startsWith('File:') ? n : `File:${n}`));
  for (let i = 0; i < titles.length; i += 40) {
    const chunk = titles.slice(i, i + 40);
    const r = await mwApi(COMMONS, { action: 'query', titles: chunk.join('|'), ...IIPROPS });
    const norm = new Map((r.query?.normalized || []).map((n) => [n.to, n.from]));
    for (const page of r.query?.pages || []) {
      const info = toFileInfo(page);
      if (!info) continue;
      const from = norm.get(page.title) || page.title;
      out.set(from.replace(/^File:/, ''), info);
    }
  }
  return out;
}

// Words that can appear in a logo filename without making it a different brand.
const NEUTRAL = new Set(`logo logos logotype logotipo wordmark word mark icon icons symbol emblem brandmark brand badge
with without text and the of new official primary secondary main current full simple simplified
black white dark light negative inverted inverse reversed reverse knockout positive mono monochrome monochromatic
grey gray silver colour color colored coloured multicolor fullcolor rgb cmyk hex transparent background bg
horizontal vertical stacked square round circle circular wide landscape portrait small large compact
version variant alt alternative only solid flat outline outlined filled app favicon on for in a by svg png webp
2d 3d hd hq high res resolution vector`.split(/\s+/));

const ICON_SET = /tabler|coreui|font ?awesome|cib-|fontisto|ionicons|octicons|bootstrap.?icons|simple.?icons|remix ?icon|feather|material.?design|boxicons|devicon|\bfa5?\b|\bfa-|noun project|icon set|fxemoji|emoji/i;
const HISTORICAL = /\b(19|20)\d\d\s*[-–—]\s*((19|20)?\d\d|present)\b|\b(old|former|previous|historic(al)?|retro|classic|vintage|anniversary|until|pre-?\d{4}|wrapped|awards?|campaign|event|fantasy|meaningful|parody|concept|fan|unofficial|redesign proposal)\b/i;

const LIGHT_WORDS = /\b(white|light|negative|inverted|inverse|reversed|knock ?out|on dark|for dark|dark ?mode|dark ?background)\b/i;
const DARK_WORDS = /\b(black|dark|positive|on white|on light|light ?mode)\b/i;
const MONO_WORDS = /\b(mono|monochrome|monochromatic|grey|gray|one ?colou?r|single ?colou?r)\b/i;

function tokens(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Classify a Commons filename for a given company. Returns null if it doesn't look like one of its logos. */
export function classifyTitle(title, names) {
  const base = title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
  if (ICON_SET.test(base)) return null;
  const baseNorm = normName(base);
  const nameMatches = names.filter((n) => n && baseNorm.includes(normName(n)));
  if (!nameMatches.length) return null;

  const nameTokens = new Set(nameMatches.flatMap(tokens));
  const unknown = tokens(base).filter((t) => !nameTokens.has(t) && !NEUTRAL.has(t) && !/^(19|20)\d\d$/.test(t) && !/^\d{1,4}(px)?$/.test(t));
  if (unknown.length > 1) return null;

  const isLight = LIGHT_WORDS.test(base);
  const isDark = DARK_WORDS.test(base) && !isLight;
  return {
    hint: isLight ? 'light' : isDark ? 'dark' : MONO_WORDS.test(base) ? 'mono' : null,
    isIcon: /\b(icon|symbol|emblem|favicon|app|without text|badge|mark)\b/i.test(base) && !/\bwordmark\b/i.test(base),
    isWordmark: /\b(wordmark|logotype|with text|text)\b/i.test(base) && !/without text/i.test(base),
    historical: HISTORICAL.test(base),
    extraWords: unknown.length,
  };
}

async function search(query, limit) {
  const r = await mwApi(COMMONS, {
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: String(limit), ...IIPROPS,
  });
  return (r.query?.pages || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map(toFileInfo).filter(Boolean);
}

async function categoryFiles(fileTitle) {
  const r = await mwApi(COMMONS, { action: 'query', titles: fileTitle, prop: 'categories', clshow: '!hidden', cllimit: '50' });
  const cats = (r.query?.pages?.[0]?.categories || []).map((c) => c.title)
    .filter((c) => /logos? of|logos$/i.test(c) && !/^Category:(SVG|PNG)? ?(logos|\d{4} .*logos)$/i.test(c) && !/text logos|logos by|logos with|unidentified/i.test(c))
    .slice(0, 2);
  const files = [];
  for (const cat of cats) {
    const m = await mwApi(COMMONS, {
      action: 'query', generator: 'categorymembers', gcmtitle: cat, gcmtype: 'file', gcmlimit: '60', ...IIPROPS,
    });
    files.push(...(m.query?.pages || []).map(toFileInfo).filter(Boolean));
  }
  return files;
}

/**
 * Find extra logo files on Commons for a company.
 * @param {string[]} names  names to match in filenames (label, user query)
 * @param {string|null} mainFile  the P154 file, whose logo categories are also scanned
 */
export async function findVariants(names, mainFile) {
  const uniq = [...new Set(names.filter(Boolean))].slice(0, 2);
  const tasks = [];
  // One SVG search per name keeps us well inside Commons' API rate limits; the logo's own
  // Commons category catches PNG variants.
  for (const n of uniq) tasks.push(search(`intitle:"${n.replace(/"/g, '')}" filemime:svg`, 50));
  if (mainFile) tasks.push(categoryFiles(`File:${mainFile}`));
  const settled = await Promise.allSettled(tasks);
  const errors = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);
  const seen = new Set();
  const results = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const f of s.value) {
      if (seen.has(f.title) || !ALLOWED_MIME.has(f.mime)) continue;
      seen.add(f.title);
      const cls = classifyTitle(f.title, uniq);
      if (cls) results.push({ ...f, ...cls });
    }
  }
  if (!results.length && errors.length === settled.length && errors.length) throw errors[0];
  return results;
}
