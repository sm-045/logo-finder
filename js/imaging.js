// Image handling: SVG sanitising/normalising, transparency + tone analysis, recolouring, PNG export.
/* global DOMPurify */

const SVG_NS = 'http://www.w3.org/2000/svg';
const ANALYSIS_EDGE = 160;

/* ---------------------------------------------------------------- SVG ---- */

function parseLength(v) {
  if (!v) return null;
  const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(px|pt|mm|cm|in|pc|em|ex)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const factor = { pt: 4 / 3, mm: 3.7795, cm: 37.795, in: 96, pc: 16, em: 16, ex: 8 }[(m[2] || '').toLowerCase()] || 1;
  return n > 0 ? n * factor : null;
}

function parseViewBox(v) {
  if (!v) return null;
  const p = v.trim().split(/[\s,]+/).map(Number);
  return p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0 ? p : null;
}

/** Off-screen shadow root so a logo's <style> can't leak into the page while we measure it. */
function withMeasuringRoot(fn) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;contain:strict;width:1px;height:1px;overflow:hidden';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  try {
    return fn(root);
  } finally {
    host.remove();
  }
}

/**
 * Sanitise an SVG string with DOMPurify and normalise its size.
 * @returns {{svgText: string, width: number, height: number, bgRect: boolean}}
 */
export function prepareSvg(text) {
  const frag = DOMPurify.sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = frag.querySelector('svg');
  if (!svg) throw new Error('File is not a usable SVG');

  const vb = parseViewBox(svg.getAttribute('viewBox'));
  let w = parseLength(svg.getAttribute('width'));
  let h = parseLength(svg.getAttribute('height'));
  if (vb && (!w || !h)) {
    if (w && !h) h = (w * vb[3]) / vb[2];
    else if (h && !w) w = (h * vb[2]) / vb[3];
    else [w, h] = [vb[2], vb[3]];
  }

  let bgRect = false;
  withMeasuringRoot((root) => {
    root.append(svg);
    if (!w || !h) {
      // No size info at all: measure the drawing and give it a viewBox.
      try {
        const bb = svg.getBBox();
        if (bb.width > 0 && bb.height > 0) {
          svg.setAttribute('viewBox', `${bb.x} ${bb.y} ${bb.width} ${bb.height}`);
          [w, h] = [bb.width, bb.height];
        }
      } catch { /* ignore */ }
    }
    if (!w || !h) [w, h] = [300, 150];
    if (!vb && !svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    bgRect = detectBackgroundRect(svg);
    svg.remove();
  });

  // A root "background" style would make the exported file opaque.
  svg.style.removeProperty('background');
  svg.style.removeProperty('background-color');
  if (!svg.getAttribute('style')) svg.removeAttribute('style');
  const svgText = new XMLSerializer().serializeToString(svg);
  return { svgText, width: w, height: h, bgRect };
}

/** True if the first painted shape is a rect covering (almost) the whole canvas. */
function detectBackgroundRect(svg) {
  const box = svg.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const shapes = [...svg.querySelectorAll('rect, path, polygon, circle, ellipse')]
    .filter((el) => !el.closest('defs, clipPath, mask, pattern, symbol, marker, linearGradient, radialGradient, filter'));
  for (const el of shapes.slice(0, 4)) {
    const cs = getComputedStyle(el);
    // (Computed visibility is inherited from the hidden measuring host, so check the element's own attribute.)
    const invisible = cs.display === 'none' || el.getAttribute('visibility') === 'hidden' || cs.fill === 'none' ||
      Number(cs.fillOpacity) === 0 || Number(cs.opacity) === 0 || /rgba\([^)]*,\s*0\)$/.test(cs.fill) || cs.fill === 'transparent';
    if (invisible) continue;
    if (el.tagName.toLowerCase() !== 'rect') return false; // first painted shape is the logo itself
    const r = el.getBoundingClientRect();
    return r.width >= box.width * 0.98 && r.height >= box.height * 0.98;
  }
  return false;
}

/** Simple Icons ship a bare path; give it an explicit colour. */
export function setSvgFill(svgText, color) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  doc.documentElement.setAttribute('fill', color);
  return new XMLSerializer().serializeToString(doc);
}

export function svgBlobUrl(svgText) {
  return URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
}

/* ------------------------------------------------------------- raster ---- */

export async function loadImage(url) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* ----------------------------------------------------------- analysis ---- */

/**
 * Draw the image on a small canvas and inspect alpha + colours.
 * @returns {{transparency: {status: 'ok'|'opaque'|'background', label: string}, tone: 'color'|'dark'|'light', fracWhite: number, fracBlack: number, fracColor: number}}
 */
export async function analyze(url, width, height) {
  const img = await loadImage(url);
  const scale = ANALYSIS_EDGE / Math.max(width, height);
  const W = Math.max(8, Math.round(width * scale));
  const H = Math.max(8, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);

  let transparentPx = 0;
  let borderOpaque = 0;
  let borderTotal = 0;
  let n = 0, nColor = 0, nDark = 0, nLight = 0, nWhite = 0, nBlack = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = data[i + 3];
      if (a < 250) transparentPx++;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) {
        borderTotal++;
        if (a > 240) borderOpaque++;
      }
      if (a < 160) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
      if (chroma > 0.18) nColor++;
      else if (lum < 0.4) nDark++;
      else if (lum > 0.78) nLight++;
      if (chroma < 0.1 && lum > 0.9) nWhite++;
      if (chroma < 0.1 && lum < 0.1) nBlack++;
    }
  }
  const total = W * H;
  const corner = (x, y) => data[(y * W + x) * 4 + 3] > 240;
  const cornersOpaque = corner(0, 0) && corner(W - 1, 0) && corner(0, H - 1) && corner(W - 1, H - 1);

  let transparency = { status: 'ok', label: 'Transparent' };
  if (transparentPx / total < 0.005) transparency = { status: 'opaque', label: 'No transparency' };
  else if (cornersOpaque && borderOpaque / borderTotal > 0.9) transparency = { status: 'background', label: 'Solid background' };

  let tone = 'color';
  if (n > 0) {
    if (nColor / n > 0.06) tone = 'color';
    else if (nDark / n > 0.85) tone = 'dark';
    else if (nLight / n > 0.85) tone = 'light';
  }
  return {
    transparency,
    tone,
    fracWhite: n ? nWhite / n : 0,
    fracBlack: n ? nBlack / n : 0,
    fracColor: n ? nColor / n : 0,
  };
}

/* ---------------------------------------------------------- recolour ----- */

/**
 * Recolour modes. All build a silhouette from the image's alpha (so fill/stroke attributes, <style>,
 * gradients, currentColor and default-black shapes are all covered) and flood it with one colour.
 *  - solid:     every painted pixel → colour
 *  - cut-light: near-white areas become transparent (white text inside a coloured shape)
 *  - cut-dark:  near-black areas become transparent (black details inside a coloured shape)
 *  - only-light: keep only near-white areas (drops a coloured background tile, keeps the white artwork)
 */
export const RECOLOR_MODES = {
  solid: 'Solid silhouette',
  'cut-light': 'Cut out white areas',
  'cut-dark': 'Cut out black areas',
  'only-light': 'Keep only white areas (drop background tile)',
};

export function suggestMode(analysis) {
  // Logo drawn as white artwork on a solid tile (e.g. ONGC): keep the artwork, drop the tile.
  if (analysis?.transparency?.status === 'background' && analysis.fracWhite > 0.05) return 'only-light';
  // White in a colour logo is almost always lettering/detail inside a shape, so cutting it out is safe.
  // Black is usually standalone lettering (cutting it would erase the wordmark), so 'cut-dark' is manual only.
  if (analysis && analysis.fracWhite > 0.02 && analysis.fracColor > 0.05) return 'cut-light';
  return 'solid';
}

const LUMA = [0.2126, 0.7152, 0.0722];
const alphaRow = (k, c) => `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${LUMA.map((v) => (v * k).toFixed(4)).join(' ')} 0 ${c}`;

/**
 * Build a recoloured SVG around a source asset.
 * @param {{kind: 'vector'|'raster', svgText?: string, blob?: Blob, width: number, height: number}} base
 */
export async function buildRecoloredSvg(base, color, mode = 'solid') {
  const { width: w, height: h } = base;
  const doc = document.implementation.createDocument(SVG_NS, 'svg', null);
  const root = doc.documentElement;
  root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  root.setAttribute('width', String(w));
  root.setAttribute('height', String(h));

  const el = (name, attrs = {}, parent) => {
    const e = doc.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (parent) parent.append(e);
    return e;
  };

  const id = 'logo-finder-recolor';
  const defs = el('defs', {}, root);
  const filter = el('filter', {
    id, filterUnits: 'userSpaceOnUse', x: 0, y: 0, width: w, height: h, 'color-interpolation-filters': 'sRGB',
  }, defs);
  let mask = 'SourceAlpha';
  if (mode === 'cut-light' || mode === 'cut-dark' || mode === 'only-light') {
    // alpha := clamp(k·luma + c), then multiplied by the source alpha.
    const values = { 'cut-light': alphaRow(-10, 9.5), 'cut-dark': alphaRow(10, -0.5), 'only-light': alphaRow(10, -8.5) }[mode];
    el('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values, result: 'lumaAlpha' }, filter);
    el('feComposite', { in: 'lumaAlpha', in2: 'SourceAlpha', operator: 'in', result: 'shape' }, filter);
    mask = 'shape';
  }
  el('feFlood', { 'flood-color': color, 'flood-opacity': 1, result: 'flood' }, filter);
  el('feComposite', { in: 'flood', in2: mask, operator: 'in' }, filter);

  const g = el('g', { filter: `url(#${id})` }, root);
  if (base.kind === 'vector') {
    const inner = new DOMParser().parseFromString(base.svgText, 'image/svg+xml').documentElement;
    const nested = doc.importNode(inner, true);
    for (const [k, v] of Object.entries({ x: 0, y: 0, width: w, height: h })) nested.setAttribute(k, String(v));
    g.append(nested);
  } else {
    const href = await blobToDataUrl(base.blob);
    el('image', { href, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none' }, g);
  }
  return new XMLSerializer().serializeToString(doc);
}

/* -------------------------------------------------------------- export ---- */

export function targetSize(width, height, longEdge) {
  const s = longEdge / Math.max(width, height);
  return { w: Math.max(1, Math.round(width * s)), h: Math.max(1, Math.round(height * s)) };
}

/**
 * Render to a transparent PNG with the given long edge, keeping the aspect ratio.
 * @param {{svgText?: string, blob?: Blob, width: number, height: number}} src
 */
export async function renderPng(src, longEdge) {
  const { w, h } = targetSize(src.width, src.height, longEdge);
  let url;
  if (src.svgText) {
    // Re-size the vector itself so it renders crisply instead of upscaling a bitmap.
    const doc = new DOMParser().parseFromString(src.svgText, 'image/svg+xml');
    doc.documentElement.setAttribute('width', String(w));
    doc.documentElement.setAttribute('height', String(h));
    url = svgBlobUrl(new XMLSerializer().serializeToString(doc));
  } else {
    url = URL.createObjectURL(src.blob);
  }
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function sha256(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : await data.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
