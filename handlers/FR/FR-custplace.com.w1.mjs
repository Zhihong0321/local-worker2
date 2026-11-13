export const meta = {
  task: 'FR-custplace.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['type', 'name', 'brand', 'city', 'rating', 'voters_count', 'is_certified', 'site_id', 'url'],
  canary: { found: 'Verisure', not_found: 'Zzqxkvbwfpjt Entreprise Inexistante' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://fr.custplace.com/search';

// Legal-form words that are dropped before comparing names (and from the search term).
const LEGAL_FORMS = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sci', 'snc', 'scop', 'sel', 'ltd', 'limited', 'inc', 'llc', 'gmbh', 'bv', 'nv', 'spa', 'srl', 'plc', 'sdn', 'bhd', 'ag']);

function fold(str) {
  return String(str || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Company key: case, accents, punctuation and legal form removed, words joined. */
function companyKey(str) {
  return fold(str)
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join('');
}

/** The keyword without its legal-form words, original spelling kept (used as the search term). */
function coreName(keyword) {
  return keyword
    .trim()
    .split(/\s+/)
    .filter((w) => {
      const bare = fold(w).replace(/[^a-z0-9]/g, '');
      return bare && !LEGAL_FORMS.has(bare);
    })
    .join(' ');
}

/** A brand entry is the company itself; a shop entry belongs to the company named in its brand field. */
function isSameCompany(entry, key) {
  if (entry.type === 'brand') return companyKey(entry.label) === key;
  if (entry.type === 'shop') return companyKey(entry.label) === key || companyKey(entry.brand) === key;
  return false;
}

function toRecord(e) {
  return {
    type: e.type,
    name: e.label || '',
    brand: e.type === 'brand' ? e.label || '' : e.brand || '',
    city: e.city || '',
    rating: e.note ?? '',
    voters_count: e.voters_count ?? null,
    is_certified: e.is_certified === undefined ? null : Boolean(e.is_certified),
    site_id: e.id ?? null,
    url: e.url || '',
  };
}

function couldnt(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let lastUrl = '';
  try {
    const name = String(keyword || '').trim();
    if (name.length < 2) return couldnt('other', 'keyword shorter than 2 characters', '');

    const key = companyKey(name);
    const queries = [...new Set([coreName(name), name])].filter((q) => q.length >= 2);
    if (!key || queries.length === 0) return couldnt('other', 'no usable company name in keyword', '');

    for (const term of queries) {
      const url = `${SEARCH}?term=${encodeURIComponent(term)}&with_shops=1&with_categories=1`;
      lastUrl = url;
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          'accept': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, url);
      if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, url);

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      if (!Array.isArray(data)) {
        if (/captcha|cf-chl|challenge-platform|access denied/i.test(text)) return couldnt('blocked', 'bot check page', url);
        return couldnt('layout_changed', text.slice(0, 300), url);
      }

      const matches = data.filter((e) => e && (e.type === 'brand' || e.type === 'shop') && isSameCompany(e, key));
      if (matches.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: matches.map(toRecord),
          source_url: url,
          excerpt: matches.map((e) => `${e.label} (${e.type})`).join('; ').slice(0, 500),
        };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `Custplace search returned no company named "${name}"`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', err?.message || err, lastUrl);
  }
}
