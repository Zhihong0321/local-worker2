export const meta = { task: 'GB-ratings.food.gov.uk', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'fhrs_id', 'business_type', 'address', 'postcode', 'local_authority', 'rating_value', 'rating_date', 'scheme_type'],
  canary: { found: 'Tesco Stores Limited', not_found: 'Xqzvortl Gastronomy Holdings Ltd' } };

// The FSA Food Hygiene Ratings site reads its data from this JSON API. It needs the x-api-version header (without it: 404).
const API = 'https://api.ratings.food.gov.uk/Establishments';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'x-api-version': '2',
};
const PAGE_SIZE = 500;     // the API accepts up to 500 per page (checked: 333 results came back in one page)
const MAX_PAGES = 4;       // at most 2000 results checked per lookup
const DEADLINE_MS = 40000; // stop paging well before the 60 s limit
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'lp', 'inc', 'co', 'corp', 'corporation', 'company', 'cic']);

function tokens(str) {
  return String(str || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** Drop a legal form at the end of the name only ("Tesco Stores Ltd" -> "tesco stores"). */
function stripLegalForm(list) {
  const t = list.slice();
  while (t.length && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function toRecord(e) {
  return {
    name: e.BusinessName || '',
    fhrs_id: e.FHRSID ?? null,
    business_type: e.BusinessType || '',
    address: [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4].filter(Boolean).join(', '),
    postcode: e.PostCode || '',
    local_authority: e.LocalAuthorityName || '',
    rating_value: e.RatingValue ?? '',
    rating_date: String(e.RatingDate || '').slice(0, 10),
    scheme_type: e.SchemeType || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // The runner exits the process right after this returns. On Windows (Node 24) an exit that comes straight after a
  // small keep-alive response aborts with a libuv assertion (exit 127), so give the socket a moment to settle first.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function run(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  let firstUrl = '';
  try {
    if (!input) return couldnt('other', API, 'empty company name');

    const keyTokens = stripLegalForm(tokens(input));
    const term = keyTokens.length ? keyTokens.join(' ') : input;
    const wantKey = (keyTokens.length ? keyTokens : tokens(input)).join('');

    const matches = [];
    let total = null;
    let fetched = 0;
    let totalPages = 1;
    let sample = null;

    for (let page = 1; page <= totalPages && page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > DEADLINE_MS) break;
      const url = `${API}?name=${encodeURIComponent(term)}&pageSize=${PAGE_SIZE}&pageNumber=${page}`;
      if (!firstUrl) firstUrl = url;

      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      let body;
      try { body = await res.json(); } catch { return couldnt('layout_changed', url, 'response is not JSON'); }
      if (!body || !Array.isArray(body.establishments) || !body.meta || typeof body.meta.totalCount !== 'number') {
        return couldnt('layout_changed', url, JSON.stringify(body).slice(0, 300));
      }
      if (body.meta.returncode && body.meta.returncode !== 'OK') {
        return couldnt('other', url, `API returncode ${body.meta.returncode}`);
      }

      total = body.meta.totalCount;
      totalPages = Number(body.meta.totalPages) || 1;
      fetched += body.establishments.length;

      for (const e of body.establishments) {
        if (tokens(e.BusinessName).length && (stripLegalForm(tokens(e.BusinessName)).join('') === wantKey)) {
          matches.push(toRecord(e));
        }
      }
      if (body.establishments.length === 0) break;
    }

    if (matches.length > 0) {
      sample = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${matches.length} record(s) named "${input}" among ${total} results for "${term}". First: ${sample.name}, ${sample.address}, ${sample.postcode}, rating ${sample.rating_value} (${sample.rating_date})`.slice(0, 500),
      };
    }

    // No exact match. Only "not_found" if every result the search returned was checked.
    if (total === 0 || fetched >= total) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `0 records named "${input}" among ${total} results for "${term}"`,
      };
    }
    return couldnt('other', firstUrl, `search for "${term}" has ${total} results; checked ${fetched} within the limit, no exact name match yet`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', firstUrl || API, String(err?.message || err));
  }
}
