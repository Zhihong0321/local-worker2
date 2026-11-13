export const meta = {
  task: 'NL-bouwgarant.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'city', 'address', 'zipcode', 'tags', 'profile_url'],
  canary: { found: 'Bouwbedrijf Selie BV', not_found: 'Onbekend Bouwbedrijf Niemandsland B.V.' },
};

// BouwGarant's contractor finder (https://www.bouwgarant.nl/vind-een-aannemer) loads its results from this JSON endpoint:
//   GET /bouwgarant/zoek-aannemers?q=<text>  ->  { results: [{ name, city, slug, tags, address_visiting: {address, zipcode} }], message }
// A name query matches contractor names that CONTAIN the text, but it does not ignore punctuation: "AJH Zwart BV" finds
// nothing while the listed name is "Aannemingsbedrijf A.J.H. Zwart B.V.". So a miss is retried with the most distinctive
// word of the name. Every candidate is still compared with the exact same normalised key, so nothing similar is "found".

const BASE = 'https://www.bouwgarant.nl';
const SEARCH = `${BASE}/bouwgarant/zoek-aannemers`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_SUFFIXES = ['bvba', 'bva', 'holding', 'bv', 'nv', 'vof', 'cv'];

/** Comparison key: lower case, no accents, no punctuation or spaces, no trailing legal form (BV, NV, VOF, ...). */
function nameKey(str) {
  let s = String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[.,'`’]/g, '').replace(/[^a-z0-9]+/g, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (s.length > suf.length && s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

/** Longest word (3+ letters, not a legal form) of the name, used for the retry query. */
function distinctiveToken(name) {
  const words = String(name || '')
    .split(/[\s.,&\-\/]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 3 && !LEGAL_SUFFIXES.includes(nameKey(w)));
  words.sort((a, b) => b.length - a.length);
  return words[0] || '';
}

function pageUrl(name) {
  return `${BASE}/vind-een-aannemer?zoek=${encodeURIComponent(name)}`;
}

function toRecord(r) {
  const addr = r.address_visiting || {};
  return {
    name: r.name || '',
    city: r.city || '',
    address: addr.address || '',
    zipcode: addr.zipcode || '',
    tags: Array.isArray(r.tags) ? r.tags : [],
    profile_url: r.slug ? `${BASE}/vind-een-aannemer/${r.slug}` : '',
  };
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** One call to the site's JSON search. Returns { fail: true, reason, url, excerpt } or { fail: false, data, url }. */
async function query(q) {
  const url = `${SEARCH}?q=${encodeURIComponent(q)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: true, reason: timeout ? 'timeout' : 'other', url, excerpt: String((err && err.message) || err) };
  }
  if (res.status === 403 || res.status === 429) {
    return { fail: true, reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { fail: true, reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: true, reason: timeout ? 'timeout' : 'other', url, excerpt: String((err && err.message) || err) };
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = null;
  }
  if (!data || !Array.isArray(data.results)) {
    const looksBlocked = /captcha|challenge|cf-chl|access denied|just a moment/i.test(text.slice(0, 5000));
    return { fail: true, reason: looksBlocked ? 'blocked' : 'layout_changed', url, excerpt: text.slice(0, 200) };
  }
  return { fail: false, data, url };
}

function matches(results, key) {
  return results.filter((r) => r && nameKey(r.name) === key);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    const key = nameKey(name);
    if (!key) return couldnt('other', '', 'empty company name');

    const first = await query(name);
    if (first.fail) return couldnt(first.reason, first.url, first.excerpt);
    let hits = matches(first.data.results, key);
    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits.map(toRecord),
        source_url: first.url,
        excerpt: `${first.data.message || ''} ${hits.map((h) => h.name).join('; ')}`.trim().slice(0, 300),
      };
    }
    let message = first.data.message || '';

    const token = distinctiveToken(name);
    if (token && nameKey(token) !== key) {
      const second = await query(token);
      if (second.fail) return couldnt(second.reason, second.url, `retry search: ${second.excerpt}`);
      hits = matches(second.data.results, key);
      if (hits.length) {
        return {
          status: 'found',
          reason: '',
          records: hits.map(toRecord),
          source_url: second.url,
          excerpt: `${second.data.message || ''} ${hits.map((h) => h.name).join('; ')}`.trim().slice(0, 300),
        };
      }
      message = second.data.message || message;
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: first.url,
      excerpt: (message || 'no contractor with this name').slice(0, 300),
    };
  } catch (err) {
    return couldnt('other', pageUrl(keyword || ''), String((err && err.message) || err));
  }
}
