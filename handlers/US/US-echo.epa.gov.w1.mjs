export const meta = {
  task: 'US-echo.epa.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'registry_id', 'street', 'city', 'state', 'zip', 'county', 'facility_compliance_status',
    'caa_compliance_status', 'cwa_compliance_status', 'rcra_compliance_status', 'inspection_count',
    'last_inspection_date', 'formal_action_count', 'total_penalties', 'naics_codes'],
  canary: { found: 'ACADIANA BOTTLING COMPANY INCORPORATED', not_found: 'QZXV HOLDINGS LLC' },
};

const BASE = 'https://echodata.epa.gov/echo/echo_rest_services';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words, dropped from the END of a name only (so "ACME CO INC WATER SYSTEM" keeps its tail).
const LEGAL = new Set(['INC', 'INCORPORATED', 'LLC', 'LLP', 'LP', 'LTD', 'LIMITED', 'CO', 'COMPANY', 'CORP', 'CORPORATION', 'PLC', 'PLLC', 'PC']);
// Stop starting new page requests after this many ms, so the whole call stays under 60 s.
const START_BUDGET_MS = 30000;

function tokens(s) {
  return String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Normalised company core: case, punctuation and trailing legal form removed. */
function core(s) {
  const t = tokens(s);
  if (t[0] === 'THE' && t.length > 1) t.shift();
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { bad: fail('couldnt_check', 'blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { bad: fail('couldnt_check', 'http_error', url, `HTTP ${res.status}`) };
  const text = await res.text();
  if (/captcha|access denied/i.test(text)) return { bad: fail('couldnt_check', 'blocked', url, text.slice(0, 200)) };
  return { text };
}

function parseResults(text, url) {
  let json;
  try { json = JSON.parse(text); } catch { return { bad: fail('couldnt_check', 'layout_changed', url, text.slice(0, 300)) }; }
  if (!json || typeof json.Results !== 'object' || json.Results === null) {
    return { bad: fail('couldnt_check', 'layout_changed', url, text.slice(0, 300)) };
  }
  return { results: json.Results };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const start = Date.now();
  const name = String(keyword || '').trim();
  const searchKey = core(name) || name;
  const searchUrl = `${BASE}.get_facilities?output=JSON&p_fn=${encodeURIComponent(searchKey)}`;
  try {
    if (!name) return fail('couldnt_check', 'other', searchUrl, 'empty company name');

    // Step 1: ECHO starts a name search and returns a QueryID plus the row count.
    const s1 = await getText(searchUrl);
    if (s1.bad) return s1.bad;
    const p1 = parseResults(s1.text, searchUrl);
    if (p1.bad) return p1.bad;
    const r1 = p1.results;
    if (r1.Error) {
      // ECHO refused the search (too many rows). That is not "not found": we cannot check it here.
      return fail('couldnt_check', 'other', searchUrl, `ECHO refused the search: ${r1.Error.ErrorMessage || 'error'}`);
    }
    const total = Number(r1.QueryRows);
    if (!r1.QueryID || !Number.isFinite(total)) {
      return fail('couldnt_check', 'layout_changed', searchUrl, s1.text.slice(0, 300));
    }

    // Step 2: read the result rows by QueryID, page by page, until all rows are read.
    const facilities = [];
    if (total > 0) {
      const qidUrl = (page) => `${BASE}.get_qid?output=JSON&qid=${encodeURIComponent(r1.QueryID)}&pageno=${page}`;
      for (let page = 1; facilities.length < total; page++) {
        if (page > 1 && Date.now() - start > START_BUDGET_MS) {
          return fail('couldnt_check', 'timeout', searchUrl, `read ${facilities.length} of ${total} rows before the time limit`);
        }
        const s2 = await getText(qidUrl(page));
        if (s2.bad) return s2.bad;
        const p2 = parseResults(s2.text, qidUrl(page));
        if (p2.bad) return p2.bad;
        const list = p2.results.Facilities;
        if (!Array.isArray(list)) {
          return fail('couldnt_check', 'layout_changed', qidUrl(page), s2.text.slice(0, 300));
        }
        if (list.length === 0) {
          return fail('couldnt_check', 'other', searchUrl, `ECHO listed ${facilities.length} of ${total} rows`);
        }
        facilities.push(...list);
      }
    }

    // Step 3: match the company by normalised name, not by similar words.
    const target = core(name);
    const matches = facilities.filter((f) => core(f.FacName) === target);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `ECHO: ${total} row(s) for "${searchKey}", none named "${target}"`.slice(0, 500),
      };
    }

    const records = matches.map((f) => ({
      name: f.FacName,
      registry_id: f.RegistryID,
      street: f.FacStreet,
      city: f.FacCity,
      state: f.FacState,
      zip: f.FacZip,
      county: f.FacCounty,
      facility_compliance_status: f.FacComplianceStatus,
      caa_compliance_status: f.CAAComplianceStatus,
      cwa_compliance_status: f.CWAComplianceStatus,
      rcra_compliance_status: f.RCRAComplianceStatus,
      inspection_count: f.FacInspectionCount,
      last_inspection_date: f.FacDateLastInspection,
      formal_action_count: f.FacFormalActionCount,
      total_penalties: f.FacTotalPenalties,
      naics_codes: f.FacNAICSCodes,
    }));
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `ECHO: ${records.length} record(s) named "${target}". First: ${first.name}, ${first.city}, ${first.state}; facility compliance: ${first.facility_compliance_status}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
