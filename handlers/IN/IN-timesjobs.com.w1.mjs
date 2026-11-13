export const meta = { task: 'IN-timesjobs.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'company_id', 'industry_key', 'industry_group_map_id'],
  canary: { found: 'INFOSYS LTD', not_found: 'Zyxqvorn Bhartiya Udyog Pvt Ltd' } };

// TimesJobs' own public company master search (the site's front end calls this same JSON API from the browser).
// Facts seen while building this: searchTerm is a case-insensitive substring match on companyName, at most 20 rows
// come back, there is no paging, and non-Latin scripts (Devanagari, Tamil, Telugu) make the site answer
// { success: false, error: SEARCH_ERROR }.
const API = 'https://tjapi.timesjobs.com/core-services/api/v1/master/companies/search';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.timesjobs.com/',
};
const ROW_CAP = 20;
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'opc', 'plc', 'llc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation']);
const START = Date.now();

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt };
}

/** Lower case, punctuation and '&' removed, legal-form words removed. Used for matching only. */
function normalize(str) {
  return (str || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t && !LEGAL.has(t)).join(' ');
}

function errorOf(e, url) {
  const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return answer('couldnt_check', timedOut ? 'timeout' : 'other', [], url, String(e?.message || e).slice(0, 300));
}

/** One search term. Returns { rows, url } or { fail } with the couldnt_check answer to return. */
async function search(term) {
  const url = `${API}?searchTerm=${encodeURIComponent(term)}`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { fail: answer('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`) };
    if (!res.ok) return { fail: answer('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`) };
    const body = await res.text();
    let json;
    try { json = JSON.parse(body); } catch { return { fail: answer('couldnt_check', 'layout_changed', [], url, body.slice(0, 300)) }; }
    if (json && json.success === false) {
      const detail = `${json.error?.code || ''} ${json.error?.description || json.message || ''}`.trim();
      return { fail: answer('couldnt_check', 'other', [], url, `the site refused this search: ${detail}`.slice(0, 300)) };
    }
    if (!json || json.success !== true || !Array.isArray(json.data)) {
      return { fail: answer('couldnt_check', 'layout_changed', [], url, body.slice(0, 300)) };
    }
    return { rows: json.data, url };
  } catch (e) {
    return { fail: errorOf(e, url) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const typed = String(keyword || '').replace(/\s+/g, ' ').trim();
    const want = normalize(typed);
    // Non-Latin scripts leave nothing to match here; the site's own search also refuses them (SEARCH_ERROR), so
    // this cannot be checked. It is never reported as not_found.
    if (!want) return answer('couldnt_check', 'other', [], API, 'no Latin letters left to match; the site search refuses non-Latin script (SEARCH_ERROR)');

    // The typed name first, then the bare name, then the bare name with common legal forms (the search is a
    // substring match, so a legal form narrows the 20-row list). Stop at the first exact match.
    const terms = [typed, want, `${want} ltd`, `${want} limited`, `${want} pvt ltd`, `${want} private limited`]
      .filter((t, i, a) => a.indexOf(t) === i);

    let capped = false;
    let lastUrl = API;
    for (const term of terms) {
      if (Date.now() - START > 30000) { // keep the whole call under the 60 s limit
        return answer('couldnt_check', 'timeout', [], lastUrl, 'stopped after 30 s of searches without a decision');
      }
      const r = await search(term);
      if (r.fail) return r.fail;
      lastUrl = r.url;
      if (r.rows.length >= ROW_CAP) capped = true;
      const hits = r.rows.filter((row) => normalize(row?.companyName) === want);
      if (hits.length) {
        const records = hits.map((row) => ({
          name: row.companyName,
          company_id: row.companyId ?? null,
          industry_key: row.industryKey ?? null,
          industry_group_map_id: row.industrygrpMapId || '',
        }));
        return answer('found', '', records, r.url, hits.map((h) => h.companyName).join(' | '));
      }
    }

    if (capped) {
      return answer('couldnt_check', 'other', [], lastUrl,
        'the search returned its 20-row maximum and none of them matched the name; the company may exist but cannot be reached by this search');
    }
    return answer('not_found', '', [], lastUrl, `0 exact matches for "${typed}" in the company search`);
  } catch (err) {
    return errorOf(err, API);
  }
}
