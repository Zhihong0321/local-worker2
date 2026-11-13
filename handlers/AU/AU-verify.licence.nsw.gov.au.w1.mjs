export const meta = {
  task: 'AU-verify.licence.nsw.gov.au',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licensee', 'licensee_type', 'licence_number', 'licence_type', 'licence_group', 'status', 'granted', 'expires', 'abn', 'acn', 'suburb', 'state', 'postcode', 'licence_id', 'matched_on'],
  canary: { found: '1300 Demolition Pty Ltd', not_found: 'Zqxvbnr Kellmoor Holdings Pty Ltd' },
};

// The site's own search API (the one its public results page calls). An empty licenceGroup searches every public register.
const API = 'https://verify.licence.nsw.gov.au/publicregisterapi/api/v1/licence/search/advQuery';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 50;
const MAX_PAGES = 4; // the site stops listing after 200 results for one search

const LEGAL_FORMS = new Set(['pty', 'ltd', 'limited', 'proprietary', 'co', 'company', 'inc', 'incorporated', 'llc', 'corp', 'corporation']);

/** Normalised name for comparison: case, punctuation and legal form removed. */
function coreName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: API, excerpt: String(excerpt || '').slice(0, 300) };
}

/** One page of the search. Returns { data } or { fail } (a couldnt_check answer). */
async function searchPage(keyword, pageNumber) {
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenceGroup: '', search: keyword, autoComplete: false, pageNumber, pageSize: PAGE_SIZE, licenceTypes: [] }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: couldnt(timedOut ? 'timeout' : 'other', String(err?.message || err)) };
  }

  const text = await res.text();
  if (res.status === 403 || res.status === 429) return { fail: couldnt('blocked', `HTTP ${res.status}`) };
  if (res.status === 400 || res.status === 404) return { fail: couldnt('layout_changed', `HTTP ${res.status} ${text.slice(0, 200)}`) };
  if (!res.ok) return { fail: couldnt('http_error', `HTTP ${res.status}`) };

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const lower = text.toLowerCase();
    const walled = lower.includes('captcha') || lower.includes('challenge') || lower.includes('access denied');
    return { fail: couldnt(walled ? 'blocked' : 'layout_changed', text.slice(0, 300)) };
  }
  if (!Array.isArray(data?.results)) return { fail: couldnt('layout_changed', text.slice(0, 300)) };
  return { data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return couldnt('other', 'empty company name');

    const first = await searchPage(name, 0);
    if (first.fail) return first.fail;

    const info = first.data.pagingInfo || {};
    const total = Number(info.totalRecords ?? first.data.results.length) || 0;
    const pages = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
    const rows = [...first.data.results];

    if (pages > 1) {
      const more = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => searchPage(name, i + 1)));
      for (const m of more) {
        if (m.fail) return m.fail;
        rows.push(...m.data.results);
      }
    }

    const want = coreName(name);
    const seen = new Set();
    const records = [];
    for (const r of rows) {
      const matchedOn = [];
      if (coreName(r.licenceName) === want) matchedOn.push('licence name');
      if (coreName(r.licensee) === want) matchedOn.push('licensee');
      if (!matchedOn.length) continue;
      const id = String(r.licenceId ?? '');
      if (seen.has(id)) continue;
      seen.add(id);
      records.push({
        name: r.licenceName ?? '',
        licensee: r.licensee ?? '',
        licensee_type: r.licenseeType ?? '',
        licence_number: r.licenceNumber ?? '',
        licence_type: r.licenceType ?? '',
        licence_group: r.licenceGroup ?? '',
        status: r.status ?? '',
        granted: r.granted ?? '',
        expires: r.expires ?? '',
        abn: r.ABN ?? '',
        acn: r.ACN ?? '',
        suburb: r.suburb ?? '',
        state: r.state ?? '',
        postcode: r.postcode ?? '',
        licence_id: id,
        matched_on: matchedOn.join(', '),
      });
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: API,
        excerpt: `${records.length} matching record(s) for "${name}" on the NSW public register`,
      };
    }

    // No match: only a complete search can say "not listed".
    if (info.totalRecordsLimitExceeded || rows.length < total) {
      return couldnt('other', `search for "${name}" has more than ${rows.length} results; the site does not list them all`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: API,
      excerpt: `0 matching records for "${name}" across all public registers`,
    };
  } catch (err) {
    return couldnt('other', String(err?.message || err));
  }
}
