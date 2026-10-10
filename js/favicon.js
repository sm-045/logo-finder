// Last-resort site icons. Sites themselves rarely send CORS headers, so we go through
// icon.horse (CORS-enabled; it looks up apple-touch-icon / favicon for the domain).
// If that fails, Google's favicon service is shown as a display-only <img>.
import { fetchWithRetry } from './net.js';

export async function findFavicon(domain) {
  if (!domain) return null;
  try {
    const blob = await fetchWithRetry(`https://icon.horse/icon/${encodeURIComponent(domain)}`, { as: 'blob', timeout: 9000, retries: 0 });
    if (blob.size > 0 && blob.type.startsWith('image/')) {
      return { blob, url: `https://icon.horse/icon/${domain}`, via: 'icon.horse', displayOnly: false };
    }
  } catch {
    // fall through to display-only
  }
  return {
    blob: null,
    url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
    via: 'Google favicon service',
    displayOnly: true,
  };
}
