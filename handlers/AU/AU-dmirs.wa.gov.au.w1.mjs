export const meta = { task: 'AU-dmirs.wa.gov.au', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'licence_type', 'licence_type_description', 'licence_number', 'licence_status', 'entity_type', 'address', 'expiry_date'],
  canary: { found: '101 CONSTRUCTION. PTY LTD', not_found: 'ZZQXJ NOTLISTED PTY LTD' } };

// WA Online Licence Search (DEMIRS). The public search page is https://ols.demirs.wa.gov.au/search, which the
// wa.gov.au licensing pages link to. It is a JSON API: GET /api/Search/licence/licenceType?LicenceType=..&FamilyNameOrBusinessName=..
// One licence type per request. No login, no captcha, no token.
const BASE = 'https://ols.demirs.wa.gov.au';
const SEARCH_PAGE = 'https://ols.demirs.wa.gov.au/search';
// Company-level licence types for the register described in the research: builders, painters, plumbers,
// electrical contractors, real estate agents, settlement agents.
const LICENCE_TYPES = ['BC', 'PC', 'PL', 'EC', 'RA', 'SA', 'SB'];
const PAGE_SIZE = 200;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['PTY', 'LTD', 'LIMITED', 'PTE', 'INC', 'INCORPORATED', 'CO', 'COMPANY', 'CORP', 'CORPORATION', 'LLC', 'SDN', 'BHD']);

/** Key for comparing names: upper case, punctuation and spaces removed, trailing legal form dropped. */
function nameKey(str) {
  const tokens = (str || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

/** Search text sent to the site: the name as typed, with the trailing legal form removed (the site does not match "PTY LTD" against "PTY. LTD"). */
function searchText(keyword) {
  let s = (keyword || '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const m = s.match(/^(.*?)[\s,.]+(PTY|LTD|LIMITED|PTE|INC|INCORPORATED|CO|COMPANY|CORP|CORPORATION|LLC|SDN|BHD)\.?$/i);
    if (!m || !m[1].trim()) break;
    s = m[1].trim();
  }
  return s.replace(/[\s,.]+$/, '');
}

function errorResult(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

async function searchType(type, text) {
  const url = `${BASE}/api/Search/licence/licenceType?` + new URLSearchParams({
    LicenceType: type,
    FamilyNameOrBusinessName: text,
    SearchAll: 'false',
    'PagingParameters.PageIndex': '0',
    'PagingParameters.PageSize': String(PAGE_SIZE),
  }).toString();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': SEARCH_PAGE },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { type, error: timeout ? 'timeout' : 'other', excerpt: `${type}: ${timeout ? 'no answer in 25 s' : String(e && e.message || e)}` };
  }
  if (res.status === 403 || res.status === 429) return { type, error: 'blocked', excerpt: `${type}: HTTP ${res.status}` };
  if (!res.ok) return { type, error: 'http_error', excerpt: `${type}: HTTP ${res.status}` };

  let body;
  try { body = JSON.parse(await res.text()); } catch { return { type, error: 'layout_changed', excerpt: `${type}: answer is not JSON` }; }
  if (!body || typeof body !== 'object' || !Array.isArray(body.licenceResponseDtos)) {
    return { type, error: 'layout_changed', excerpt: `${type}: unexpected answer shape` };
  }
  const rows = body.licenceResponseDtos;
  const total = Number(body.totalRecords);
  // The site says "Invalid search criteria" when nothing matches; any other message is not a normal answer.
  if (rows.length === 0 && body.message && !/invalid search criteria/i.test(body.message)) {
    return { type, error: 'other', excerpt: `${type}: ${body.message}` };
  }
  if (rows.length < total) {
    // Keep the rows we have (a match there is still a match); but this type was not read in full.
    return { type, rows, error: 'other', excerpt: `${type}: ${total} results, only the first ${rows.length} could be read` };
  }
  return { type, rows };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const text = searchText(keyword);
    if (nameKey(text).length < 2) return errorResult('other', SEARCH_PAGE, 'name too short to search');

    const answers = await Promise.all(LICENCE_TYPES.map((t) => searchType(t, text)));
    const want = nameKey(keyword);

    const records = [];
    const seen = new Set();
    for (const a of answers) {
      if (!a.rows) continue;
      for (const r of a.rows) {
        if (!r.entityName || nameKey(r.entityName) !== want) continue;
        const id = `${r.licenceId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({
          name: r.entityName,
          licence_type: r.actualLicenceTypeCode,
          licence_type_description: r.licenceTypeDescription,
          licence_number: r.licenceNumber,
          licence_status: r.licenceStatus,
          entity_type: r.entityType,
          address: r.address && r.address.address ? r.address.address : '',
          expiry_date: r.expiryDate,
        });
      }
    }

    const failed = answers.filter((a) => a.error);
    const readOk = answers.filter((a) => !a.error).map((a) => a.type).join(', ');
    const note = failed.map((a) => a.excerpt).join(' | ');

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: SEARCH_PAGE,
        excerpt: `Matched ${records.length} licence record(s) for "${keyword}" in ${readOk || 'no type in full'}` + (note ? `; not read in full: ${note}` : ''),
      };
    }
    if (failed.length > 0) {
      // A site that refuses or fails is never "not found". Use the first failure's reason.
      return errorResult(failed[0].error, SEARCH_PAGE, note);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SEARCH_PAGE,
      excerpt: `No licence record named "${keyword}" in ${LICENCE_TYPES.join(', ')}`,
    };
  } catch (err) {
    return errorResult('other', SEARCH_PAGE, err && err.message ? err.message : err);
  }
}
