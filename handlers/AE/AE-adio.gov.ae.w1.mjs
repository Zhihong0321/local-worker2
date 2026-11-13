export const meta = { task: 'AE-adio.gov.ae', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'scope', 'type', 'location', 'origin'],
  canary: { found: 'Masdar', not_found: 'شركة الصحراء الذهبية للتجارة ذ.م.م' } };

// ADIO's Ecosystem Directory (the site adio.gov.ae now redirects here). The full list of 34 local and 45 international
// entities is embedded in the page as JSON, so one GET gives the whole list.
const DIRECTORY_URL = 'https://www.investwithabudhabi.com/en/ecosystem-directory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form and generic words that do not identify a company ("Agthia Group" matches "Agthia").
const DROP = new Set(['llc', 'llp', 'pjsc', 'psc', 'plc', 'ltd', 'limited', 'inc', 'fze', 'fzco', 'fzllc', 'fz', 'sdn', 'bhd',
  'co', 'company', 'group', 'holding', 'holdings', 'the']);

const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

function decode(s) {
  return String(s || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Normalised form of a name: lower case, no punctuation, no accents, no legal form words. */
function nameKey(str) {
  return decode(str).toLowerCase()
    .replace(/&/g, ' and ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .split(' ').filter((w) => w && !DROP.has(w)).join('');
}

/** Every normalised name one entry answers to: the full name, the name without "(ACRONYM)", and the acronym. */
function nameKeys(name) {
  const keys = new Set([nameKey(name)]);
  const m = decode(name).match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) { keys.add(nameKey(m[1])); keys.add(nameKey(m[2])); }
  keys.delete('');
  return keys;
}

/** Pull the entity records out of the page's embedded JSON (escaped quotes are turned back into plain quotes first). */
function readEntities(html) {
  const t = html.replace(/\\"/g, '"');
  const seen = new Map();
  for (const m of t.matchAll(/\{"name":"([^"]+)","type":"([^"]+)","location":"([^"]+)"\}/g)) {
    const name = decode(m[1]);
    if (!seen.has(name)) seen.set(name, { name, scope: 'local', type: decode(m[2]), location: decode(m[3]), origin: '' });
  }
  for (const m of t.matchAll(/\{"name":"([^"]+)","origin":"([^"]+)","type":"([^"]+)","location":"([^"]+)"\}/g)) {
    const name = decode(m[1]);
    if (!seen.has(name)) seen.set(name, { name, scope: 'international', type: decode(m[3]), location: decode(m[4]), origin: decode(m[2]) });
  }
  return [...seen.values()];
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const url = DIRECTORY_URL;
  try {
    const kwKeys = nameKeys(String(keyword || ''));
    if (kwKeys.size === 0) return fail('other', url, 'the keyword has no name words to compare');

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

    const html = await res.text();
    if (!html.includes('Ecosystem Directory')) {
      if (/just a moment|captcha|cf-chl/i.test(html)) return fail('blocked', url, 'bot check page');
      return fail('layout_changed', url, html.slice(0, 300));
    }

    const entities = readEntities(html);
    const localCount = entities.filter((e) => e.scope === 'local').length;
    const intlCount = entities.length - localCount;
    if (localCount === 0 || intlCount === 0) return fail('layout_changed', url, `entity list not found in page (${entities.length} parsed)`);

    const hits = entities.filter((e) => {
      const keys = nameKeys(e.name);
      return [...kwKeys].some((k) => keys.has(k));
    });

    if (hits.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `The Ecosystem Directory lists ${localCount} local and ${intlCount} international entities; "${keyword}" is not one of them`,
      };
    }
    return {
      status: 'found', reason: '',
      records: hits.map(({ name, scope, type, location, origin }) => ({ name, scope, type, location, origin })),
      source_url: url,
      excerpt: hits.map((h) => `${h.name}: ${h.type}, ${h.location}${h.origin ? ` (${h.origin})` : ''}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', url, String(err?.message || err).slice(0, 300));
  }
}
