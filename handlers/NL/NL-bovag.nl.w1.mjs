export const meta = {
  task: 'NL-bovag.nl',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_id', 'kvk_number', 'address', 'website', 'services', 'slug'],
  canary: { found: 'Garage Hoogesteger B.V.', not_found: 'Zandbak Onbestaand Bedrijf B.V.' },
};

// The public member search on https://www.bovag.nl/zoek-bovag-bedrijf runs in the browser against this
// Algolia index, using the search-only key that the site ships to every visitor in its JavaScript.
const ALGOLIA_APP = 'C2PG678GKC';
const ALGOLIA_KEY = '463a2bea7a3cdd13ed725a3f5d390436';
const ALGOLIA_INDEX = 'bovag-members';
const SEARCH_PAGE = 'https://www.bovag.nl/zoek-bovag-bedrijf';
const MEMBER_PAGE = (slug) => `https://www.bovag.nl/leden/${encodeURIComponent(slug)}`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Dutch legal forms, written after the name (B.V., N.V., V.o.f., ...). Dots are removed first, so "B.V." -> "bv"
// and "B. V." -> "b v".
const LEGAL_FORMS = /(^| )(b v|n v|v o f|c v|bv|nv|vof|cv|bvba|vzw|ltd|limited|gmbh|sarl)$/;

/** Name without case, accents, punctuation or the trailing legal form, as lower-case words for comparison. */
function splitLegal(name) {
  let s = (name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '')
    .split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  let before;
  do { before = s; s = s.replace(LEGAL_FORMS, ''); } while (s !== before && s.length > 0);
  return s;
}

function coreName(name) {
  return splitLegal(name).replace(/ /g, '');
}

function addressOf(a) {
  if (!a) return '';
  const street = [a.street, a.housenumber, a.numberAddition].filter((x) => x !== null && x !== undefined && x !== '').join(' ');
  return [street, [a.postalCode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const wanted = coreName(keyword);
  const queryText = splitLegal(keyword) || String(keyword || '').trim();
  const url = `https://${ALGOLIA_APP}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;
  try {
    if (!wanted) {
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE, excerpt: 'empty company name' };
    }
    const params = new URLSearchParams({ query: queryText, hitsPerPage: '50' }).toString();
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': ALGOLIA_APP,
        'X-Algolia-API-Key': ALGOLIA_KEY,
        'Referer': 'https://www.bovag.nl/',
      },
      body: JSON.stringify({ params }),
    });

    if (res.status === 403 || res.status === 401 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH_PAGE, excerpt: `HTTP ${res.status}` };
    }

    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.hits)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_PAGE,
               excerpt: JSON.stringify(data || {}).slice(0, 300) };
    }

    const matches = data.hits.filter((h) => h && coreName(h.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE,
        excerpt: `BOVAG member search: ${data.nbHits ?? data.hits.length} hits for "${queryText}", none with this name`,
      };
    }

    const records = matches.map((h) => ({
      name: h.name,
      member_id: h.memberId || '',
      kvk_number: h.kvkNumber || '',
      address: addressOf(h.address),
      website: h.website || '',
      services: Array.isArray(h.services) ? h.services.map((s) => s.value).filter(Boolean) : [],
      slug: h.slug || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].slug ? MEMBER_PAGE(records[0].slug) : SEARCH_PAGE,
      excerpt: `BOVAG member: ${records.map((r) => `${r.name} (member ${r.member_id}, KvK ${r.kvk_number})`).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: SEARCH_PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
