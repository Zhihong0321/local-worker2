export const meta = {
  task: 'GB-environment.data.gov.uk',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'register', 'registration_type', 'registration_date', 'expiry_date', 'address', 'tier', 'url'],
  canary: { found: 'Tesco Stores Ltd', not_found: 'Zxqvbnmpl Holdings' },
};

// Public Registers Online cross-register JSON search (documented in the site's API spec, no login).
const API = 'https://environment.data.gov.uk/public-register/api/search.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 500;          // records per request (API maximum is 10,000)
const MAX_PAGES = 4;       // at most 2,000 search results per lookup
const BUDGET_MS = 40000;   // stop paging well before the 60 s limit

// Trailing legal-form words that are dropped before comparing names (UK forms).
const LEGAL = new Set(['limited', 'ltd', 'llp', 'plc', 'cic', 'co', 'company', 'corporation', 'corp', 'inc', 'lp', 'and']);

function tokens(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function coreTokens(s) {
  const t = tokens(s);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

/** Comparable key: case, punctuation, accents and trailing legal form ignored. */
function key(s) {
  return coreTokens(s).join('');
}

function firstSite(site) {
  return Array.isArray(site) ? site[0] || {} : site || {};
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const want = key(keyword);
  const q = coreTokens(keyword).join(' ');
  if (!want) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'no name words in the input' };
  }
  const firstUrl = `${API}?name-search=${encodeURIComponent(q)}&_limit=${PAGE}`;

  try {
    const items = [];
    let offset = 0;
    let pages = 0;
    let truncated = false;

    for (;;) {
      const url = `${API}?name-search=${encodeURIComponent(q)}&_limit=${PAGE}${offset ? `&_offset=${offset}` : ''}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: firstUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: firstUrl, excerpt: `HTTP ${res.status}` };
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl, excerpt: text.slice(0, 300) };
      }
      if (!json || !Array.isArray(json.items)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl, excerpt: text.slice(0, 300) };
      }

      items.push(...json.items);
      pages++;
      if (json.items.length < PAGE) break; // last page reached

      offset += PAGE;
      if (pages >= MAX_PAGES || Date.now() - started > BUDGET_MS) {
        truncated = true;
        break;
      }
    }

    const seen = new Set();
    const records = [];
    for (const it of items) {
      const holder = it?.holder?.name || '';
      if (key(holder) !== want) continue;
      const id = it['@id'] || `${it.registrationNumber || ''}|${holder}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const site = firstSite(it.site);
      records.push({
        name: holder,
        registration_number: it.registrationNumber || '',
        register: it.register?.label || '',
        registration_type: it.registrationType?.label || '',
        registration_date: it.registrationDate || '',
        expiry_date: it.expiryDate || '',
        address: site.siteAddress?.address || '',
        tier: it.tier?.label || '',
        url: String(it['@id'] || '').replace(/^http:\/\//, 'https://'),
      });
    }

    if (records.length) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${records.length} registration(s) held by "${first.name}" (${first.register})` +
          (truncated ? `; search was cut short after ${items.length} results, more may exist` : ''),
      };
    }

    if (truncated) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: firstUrl,
        excerpt: `search for "${q}" returned more than ${items.length} results; the company could not be checked in full`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 holders match "${keyword}" among ${items.length} results for "${q}"`,
    };
  } catch (err) {
    const name = err?.name || '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
