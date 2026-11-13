export const meta = {
  task: 'AR-amcham.com.ar', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'partner_id', 'website', 'categories', 'location', 'american_origin'],
  canary: { found: 'ABBOTT LABORATORIES ARGENTINA S.A.', not_found: 'Inversora Fantasma Zqxv S.A.' },
};

// AmCham Argentina's member directory (https://www.amcham.com.ar/nuestros-socios) is a React page. The page loads
// its partner list from a public GraphQL endpoint with one POST and no login. That endpoint returns the full list
// (about 666 companies) in one response, so the handler fetches it and matches the keyword locally.
// reference_email is deliberately not returned: it is a named person's contact, which the record does not need.
const GRAPHQL_URL = 'https://ho60hqzg34.execute-api.us-east-1.amazonaws.com/';
const PAGE_URL = 'https://www.amcham.com.ar/nuestros-socios';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUERY = 'query Query { partners { id name website american_origin categories location } }';

// Legal-form words and single letters ("S.A.C.I.F.I.A." becomes single letters) are dropped before comparing.
const LEGAL = new Set(['sa', 'srl', 'sas', 'saci', 'sacif', 'sacifi', 'sacifia', 'sacifiia', 'sca', 'scs', 'sau',
  'sc', 'ltda', 'inc', 'llc', 'ltd', 'corp', 'co', 'sociedad', 'anonima', 'responsabilidad', 'limitada']);

/** Comparison key: lower case, no accents, no punctuation, no legal form, no spaces. */
function key(str) {
  const tokens = (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t && t.length > 1 && !LEGAL.has(t));
  return tokens.join('');
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const wanted = key(keyword);
  if (!wanted) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'empty company name' };
  }
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Apollo-Operation-Name': 'amcham',
        'Apollo-Require-Preflight': '1',
      },
      body: JSON.stringify({ query: QUERY }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch {
      const low = text.slice(0, 2000).toLowerCase();
      const reason = /captcha|challenge|cloudflare|access denied/.test(low) ? 'blocked' : 'layout_changed';
      return { status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: text.slice(0, 300) };
    }

    if (body && body.errors && !(body.data && Array.isArray(body.data.partners))) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
        excerpt: clean(JSON.stringify(body.errors)).slice(0, 300) };
    }
    const partners = body && body.data && body.data.partners;
    if (!Array.isArray(partners)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: text.slice(0, 300) };
    }

    const matches = partners.filter((p) => key(p && p.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
        excerpt: `0 matches for "${clean(keyword)}" among ${partners.length} listed partners`,
      };
    }

    const records = matches.map((p) => ({
      name: clean(p.name),
      partner_id: clean(p.id),
      website: clean(p.website),
      categories: Array.isArray(p.categories) ? p.categories.map(clean) : [],
      location: Array.isArray(p.location) ? p.location.map(clean) : [],
      american_origin: p.american_origin === true,
    }));

    return {
      status: 'found', reason: '', records, source_url: PAGE_URL,
      excerpt: `${records.length} match(es) for "${clean(keyword)}" in ${partners.length} listed partners: ${records[0].name}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: PAGE_URL,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
