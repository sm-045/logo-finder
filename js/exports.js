// Download helpers shared by single and batch mode.
import { renderPng } from './imaging.js';
import { SOURCE_LABELS } from './finder.js';

export function slugify(s) {
  return (s || 'logo').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^File:/, '').replace(/\.[a-z]{3,4}$/i, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'logo';
}

/** Folder-safe version of a company name that keeps it readable. */
export function folderName(s) {
  return (s || 'company').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'company';
}

/** True vector SVG available (generated variants of raster logos embed a bitmap, so they're PNG-only). */
export const canSvg = (a) => Boolean(a && !a.displayOnly && a.svgText && (a.kind === 'vector'));
export const canPng = (a) => Boolean(a && !a.displayOnly && (a.svgText || a.blob));

export function svgBlob(a) {
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${a.svgText}`], { type: 'image/svg+xml' });
}

export function pngBlob(a, size) {
  return renderPng({ svgText: a.svgText, blob: a.blob, width: a.width, height: a.height }, size);
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function describeAsset(a) {
  if (!a) return 'none';
  if (a.generated) {
    return `GENERATED (${a.color === '#000000' ? 'black' : 'white'} recolour, ${a.mode}) from "${a.base.title.replace(/^File:/, '')}" — ${a.base.pageUrl || a.base.fileUrl}`;
  }
  const src = SOURCE_LABELS[a.source] || a.source;
  return `${a.title.replace(/^File:/, '')} — ${src} — licence: ${a.license || 'unknown'} — ${a.pageUrl || a.fileUrl}`;
}
