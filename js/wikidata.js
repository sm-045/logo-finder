// Wikidata: find the company entity and read its logo properties.
import { mwApi } from './net.js';

const WD = 'https://www.wikidata.org/w/api.php';

const P_LOGO = 'P154';        // logo image
const P_SMALL_LOGO = 'P8972'; // small logo or icon
const P_ICON = 'P2910';       // icon
const P_WEBSITE = 'P856';     // official website
const P_END = 'P582';         // end time (qualifier) → historical logo
const P_SCHEME = 'P8798';     // for color scheme (qualifier)
const Q_DARK_ON_LIGHT = 'Q101608434';
const Q_LIGHT_ON_DARK = 'Q6545942';

const COMPANYISH = /\b(company|companies|corporation|corp|business|brand|manufacturer|enterprise|conglomerate|start-?up|service|platform|bank|airline|retailer|firm|group|holding|operator|provider|producer|maker|chain|network|software|website|app|marketplace|subsidiary|multinational|organi[sz]ation|publisher|studio|agency|label|cooperative|limited|inc\.?|plc|ltd)\b/i;
const NOT_COMPANY = /\b(given name|family name|surname|species|genus|family of|mythology|goddess|god of|disambiguation|film|album|song|single|character|episode|painting|asteroid|chemical|village|river|mountain|wikimedia|scholarly article|human|identifier|band \(|tournament|award|stadium|station|school)\b/i;

export function normName(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

export function normDomain(input) {
  if (!input) return '';
  let s = input.trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s;
  try {
    return new URL(s).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function domainMatches(urls, domain) {
  if (!domain) return false;
  return urls.some((u) => {
    const h = normDomain(u);
    return h && (h === domain || h.endsWith('.' + domain) || domain.endsWith('.' + h));
  });
}

const val = (snak) => snak?.datavalue?.value;

function statements(claims, prop) {
  return (claims?.[prop] || []).filter((s) => s.rank !== 'deprecated' && val(s.mainsnak) != null);
}

function readLogos(claims, prop) {
  const list = statements(claims, prop).map((s) => {
    const schemes = (s.qualifiers?.[P_SCHEME] || []).map((q) => val(q)?.id);
    let scheme = null;
    const dol = schemes.includes(Q_DARK_ON_LIGHT);
    const lod = schemes.includes(Q_LIGHT_ON_DARK);
    if (dol && !lod) scheme = 'dark';
    else if (lod && !dol) scheme = 'light';
    return {
      file: val(s.mainsnak),
      preferred: s.rank === 'preferred',
      historical: Boolean(s.qualifiers?.[P_END]),
      scheme,
    };
  });
  // Preferred first, then current, then historical. Stable otherwise.
  const score = (l) => (l.preferred ? 0 : 1) + (l.historical ? 2 : 0);
  list.sort((a, b) => score(a) - score(b));
  // Same file can be listed twice (e.g. preferred + normal).
  const seen = new Set();
  return list.filter((l) => (seen.has(l.file) ? false : seen.add(l.file)));
}

function toCandidate(entity, query, domain, index) {
  const claims = entity.claims || {};
  const label = entity.labels?.en?.value || entity.id;
  const description = entity.descriptions?.en?.value || '';
  const websites = statements(claims, P_WEBSITE).map((s) => val(s.mainsnak));
  const logos = readLogos(claims, P_LOGO);
  const icons = [...readLogos(claims, P_SMALL_LOGO), ...readLogos(claims, P_ICON)]
    .filter((v, i, a) => a.findIndex((x) => x.file === v.file) === i);
  const hasEnwiki = Boolean(entity.sitelinks?.enwiki);
  const domainMatch = domainMatches(websites, domain);

  let score = 0;
  if (domainMatch) score += 100;
  if (logos.length) score += 3;
  if (websites.length) score += 2;
  if (hasEnwiki) score += 1;
  if (normName(label) === normName(query)) score += 3;
  if (COMPANYISH.test(description)) score += 2;
  if (NOT_COMPANY.test(description)) score -= 5;
  score += Math.max(0, 10 - index) * 0.3;

  const orgLike = domainMatch || logos.length > 0 || ((websites.length > 0 || COMPANYISH.test(description)) && !NOT_COMPANY.test(description));
  return {
    id: entity.id,
    label,
    description,
    websites,
    website: websites[0] || null,
    logos,
    icons,
    domainMatch,
    orgLike,
    score,
    url: `https://www.wikidata.org/wiki/${entity.id}`,
    enwiki: entity.sitelinks?.enwiki?.title || null,
  };
}

async function idsByWebsite(domain) {
  const variants = [];
  for (const scheme of ['https', 'http']) {
    for (const www of ['www.', '']) {
      for (const slash of ['/', '']) variants.push(`P856=${scheme}://${www}${domain}${slash}`);
    }
  }
  const r = await mwApi(WD, {
    action: 'query', list: 'search', srsearch: `haswbstatement:${variants.join('|')}`, srlimit: '5', srnamespace: '0',
  });
  return (r.query?.search || []).map((x) => x.title);
}

/**
 * Search Wikidata for organisations matching a name (and optional domain).
 * @returns {Promise<{candidates: object[], ambiguous: boolean}>}
 */
export async function findCompanies(name, domain = '') {
  const [byName, byDomain] = await Promise.all([
    name
      ? mwApi(WD, { action: 'wbsearchentities', search: name, language: 'en', uselang: 'en', type: 'item', limit: '10' })
        .then((r) => (r.search || []).map((x) => x.id))
      : Promise.resolve([]),
    domain ? idsByWebsite(domain).catch(() => []) : Promise.resolve([]),
  ]);

  const ids = [...new Set([...byName, ...byDomain])].slice(0, 15);
  if (!ids.length) return { candidates: [], ambiguous: false };

  const r = await mwApi(WD, {
    action: 'wbgetentities', ids: ids.join('|'), props: 'claims|labels|descriptions|sitelinks', languages: 'en', sitefilter: 'enwiki',
  });
  const entities = r.entities || {};
  const candidates = ids
    .map((id, i) => entities[id] && !entities[id].missing ? toCandidate(entities[id], name || domain, domain, byName.includes(id) ? byName.indexOf(id) : 10) : null)
    .filter((c) => c && c.orgLike)
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const ambiguous = Boolean(
    top && !top.domainMatch && candidates.length > 1 &&
    candidates.slice(1).some((c) => (c.logos.length || c.websites.length) && top.score - c.score < 6),
  );
  return { candidates, ambiguous };
}
