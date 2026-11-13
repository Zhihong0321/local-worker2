export const meta = { task: 'AU-pericles.ipaustralia.gov.au', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['identifier', 'auApplicationNumber', 'inventionTitle', 'patentType', 'filingDate', 'earliestPriorityDate', 'applicationStatus', 'applicants', 'inventors', 'agents', 'pctApplicationNumber', 'wipoApplicationNumber'],
  canary: { found: 'Blackmores Limited', not_found: 'Zyxwvut Quantum Widgets Pty Ltd' } };

// The AusPat search page (pericles.ipaustralia.gov.au, now served from ipsearch.ipaustralia.gov.au/patents/) runs on this public
// JSON API. The page sends GET <API>/patents?query=<terms IN AP>&limit=&offset= and reads "count" and "results".
const API = 'https://production.api.ipaustralia.gov.au/public/ipright-search-api/v1/patents';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Checked by hand: with limit 100 or 200 "count" is right; with limit 300 or more it is wrong (0), and the API is slow
// (about 5-8 s a page), so pages are 100 rows and a new page is not started after 30 s.
const PAGE = 100;
const MAX_ROWS = 5000;      // the search page itself stops at 5000 results
const NO_NEW_PAGE_AFTER_MS = 30000;

// Legal-form words are dropped on both sides, so "Dow AgroSciences LLC" matches "Dow AgroSciences, LLC".
const LEGAL = new Set(['pty', 'ltd', 'limited', 'llc', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'company', 'plc',
  'gmbh', 'ag', 'sa', 'bv', 'nv', 'pte', 'sdn', 'bhd', 'pvt', 'llp', 'lp', 'ltda', 'sarl', 'kk']);

function tokens(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL.has(t));
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const core = tokens(keyword);
    if (core.length === 0) return couldnt('other', '', 'no searchable words in the company name');
    const coreKey = core.join(' ');
    const query = `${coreKey} IN AP`; // AP = applicant name field
    const pageUrl = (offset) => `${API}?query=${encodeURIComponent(query)}&limit=${PAGE}&offset=${offset}`;
    const sourceUrl = pageUrl(0);
    const headers = { 'User-Agent': UA, 'Accept': 'application/json' };

    const rows = [];
    let total = null;
    let outOfTime = false;
    for (let offset = 0; ; offset += PAGE) {
      if (offset > 0 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) { outOfTime = true; break; }
      let res;
      try {
        res = await fetch(pageUrl(offset), { headers, signal: AbortSignal.timeout(25000) });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return couldnt(timedOut ? 'timeout' : 'other', pageUrl(offset), String(err?.message || err).slice(0, 300));
      }
      if (res.status === 403 || res.status === 429) return couldnt('blocked', pageUrl(offset), `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', pageUrl(offset), `HTTP ${res.status}`);

      let data;
      try { data = await res.json(); } catch { return couldnt('layout_changed', pageUrl(offset), 'response is not JSON'); }
      if (!data || typeof data.count !== 'number' || !Array.isArray(data.results)) {
        return couldnt('layout_changed', pageUrl(offset), JSON.stringify(data).slice(0, 300));
      }
      total = data.count;
      rows.push(...data.results);
      if (data.results.length === 0 || rows.length >= total || offset + PAGE >= MAX_ROWS) break;
    }

    // Match the company, not similar words: the applicant list is ';'-separated, compare each name without legal form.
    const matches = rows.filter((r) => String(r.applicants || '').split(';').some((a) => tokens(a).join(' ') === coreKey));
    const complete = rows.length >= total;

    if (matches.length > 0) {
      const partial = complete ? '' : ` Only ${rows.length} of ${total} search results were read in time, so there may be more.`;
      const records = matches.map((r) => ({
        identifier: r.identifier,
        auApplicationNumber: r.auApplicationNumber,
        inventionTitle: r.inventionTitle,
        patentType: r.patentType,
        filingDate: r.filingDate,
        earliestPriorityDate: r.earliestPriorityDate,
        applicationStatus: r.applicationStatus,
        applicants: r.applicants,
        inventors: r.inventors,
        agents: r.agents,
        pctApplicationNumber: r.pctApplicationNumber,
        wipoApplicationNumber: r.wipoApplicationNumber,
      }));
      return {
        status: 'found', reason: '', records, source_url: sourceUrl,
        excerpt: `${matches.length} patent record(s) list "${keyword}" as applicant.${partial}`,
      };
    }

    if (complete) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `search returned ${total} result(s); none lists an applicant named "${keyword}"`,
      };
    }
    return couldnt(outOfTime ? 'timeout' : 'other', sourceUrl,
      `search has ${total} results but only ${rows.length} were read; cannot prove the company is absent`);
  } catch (err) {
    return couldnt('other', API, String(err?.message || err).slice(0, 300));
  }
}
