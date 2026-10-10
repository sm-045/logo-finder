// English Wikipedia infobox image. Many company logos are non-free and live on Wikipedia rather than
// Commons, so Wikidata has no P154 for them; the article's lead image is usually that logo.
import { mwApi } from './net.js';
import { normName } from './wikidata.js';

const EN = 'https://en.wikipedia.org/w/api.php';

const stripHtml = (s) => (s ? (new DOMParser().parseFromString(String(s), 'text/html').body.textContent || '').trim() : '');

export async function findPageImage(articleTitle, names) {
  if (!articleTitle) return null;
  const r = await mwApi(EN, { action: 'query', titles: articleTitle, prop: 'pageimages', piprop: 'name', pilicense: 'any', redirects: '1' });
  const file = r.query?.pages?.[0]?.pageimage;
  if (!file) return null;

  // Only accept it if it looks like a logo (lead images can also be HQ photos, products, people...).
  const base = normName(file.replace(/\.[a-z]+$/i, ''));
  const looksLikeLogo = /logo|wordmark|logotype|brand/i.test(file) || names.some((n) => n && base.includes(normName(n)));
  if (!looksLikeLogo) return null;

  const info = await mwApi(EN, {
    action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|Artist|NonFree',
  });
  const page = info.query?.pages?.[0];
  const ii = page?.imageinfo?.[0];
  if (!ii || !['image/svg+xml', 'image/png', 'image/webp'].includes(ii.mime)) return null;
  const meta = ii.extmetadata || {};
  const nonFree = meta.NonFree?.value === 'true' || meta.NonFree?.value === true;
  return {
    title: page.title,
    url: ii.url.split('?')[0],
    pageUrl: ii.descriptionurl,
    mime: ii.mime,
    width: ii.width,
    height: ii.height,
    license: stripHtml(meta.LicenseShortName?.value) || (nonFree ? 'Non-free (fair use on Wikipedia)' : 'See file page'),
    author: stripHtml(meta.Artist?.value).slice(0, 120),
  };
}
