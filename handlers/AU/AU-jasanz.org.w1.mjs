export const meta = {
  task: 'AU-jasanz.org',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'certificate_number', 'status', 'expiry_date', 'certification_body', 'country', 'city', 'scopes', 'certificate_id'],
  canary: { found: '2022 Environmental Science AU Pty Ltd', not_found: 'Zorbix Quantum Widgets Pty Ltd' },
};

// JAS-ANZ public register (register.jasanz.org/certified-organisations). The page is an Angular app that
// reads its data from the public JSON API below. The search is a plain POST, no login, no token, no captcha.
const API = 'https://jasanzcupr-api.azurewebsites.net/api/V1/RegisterCertificate/GetAllFilterCertificate';
const PUBLIC_PAGE = 'https://register.jasanz.org/certified-organisations';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 200;
// Legal-form words, removed from the end of a name before comparing (e.g. "Pty Ltd", "Sdn Bhd").
const LEGAL = new Set(['pty', 'ltd', 'limited', 'proprietary', 'co', 'company', 'inc', 'incorporated', 'llc',
  'corp', 'corporation', 'plc', 'pvt', 'sdn', 'bhd']);

/** Lower-case words and digits only, "&" read as "and". */
function words(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** The name without its trailing legal form, as one string with no spaces, for comparison. */
function coreKey(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join('');
}

/** The keyword with its trailing legal form cut off, punctuation kept (the server search is a plain text match). */
function coreText(s) {
  let t = String(s || '').trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 5; i++) {
    const m = t.match(/^(.*\S)[\s,.]+([A-Za-z.]+)\.?$/);
    if (!m || !LEGAL.has(m[2].toLowerCase().replace(/\.$/, '')) || !m[1].trim()) break;
    t = m[1].trim();
  }
  return t;
}

const CANNOT = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** One search request. Returns { kind: 'rows', rows, count } | { kind: 'empty' } | { kind: 'fail', reason, excerpt }. */
async function search(text) {
  const body = {
    PageNumber: 0, PageSize: PAGE_SIZE, schemeOwnerId: null, certificateId: null, tradingName: null,
    certification: null, city: null, cab: null, certScope: null, certStatus: null,
    country: [], certificationStandards: [], cabs: [], programs: [], isicCodes: [], schemes: [], certificateNumbers: [],
    organisationName: text,
  };
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { kind: 'fail', reason: 'timeout', excerpt: 'no answer within 25 s' };
    return { kind: 'fail', reason: 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { kind: 'fail', reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { kind: 'fail', reason: 'http_error', excerpt: `HTTP ${res.status}` };

  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    return { kind: 'fail', reason: 'layout_changed', excerpt: 'the answer is not JSON' };
  }
  if (!json || typeof json.isSuccessful !== 'boolean') {
    return { kind: 'fail', reason: 'layout_changed', excerpt: 'the answer has no isSuccessful flag' };
  }
  if (json.isSuccessful === false) {
    if (json.messageDetail?.message_shortcode === 'JASANZ_RECORDS_NOT_FOUND') return { kind: 'empty' };
    return { kind: 'fail', reason: 'other', excerpt: String(json.messageDetail?.message || 'isSuccessful false').slice(0, 200) };
  }
  const rows = Array.isArray(json.data?.certificateDtos) ? json.data.certificateDtos : null;
  if (!rows) return { kind: 'fail', reason: 'layout_changed', excerpt: 'no certificateDtos list in the answer' };
  return { kind: 'rows', rows, count: Number(json.data.count) || rows.length };
}

function toRecord(r) {
  return {
    name: String(r.organisationName || '').trim(),
    certificate_number: String(r.certificateName || '').trim(),
    status: String(r.statusName || '').trim(),
    expiry_date: String(r.expriryDate || '').slice(0, 10),
    certification_body: String(r.cabName || '').trim(),
    country: String(r.countryName || '').trim(),
    city: String(r.city || '').trim(),
    scopes: (r.scopes || []).map((s) => String(s.scopeName || '').trim()).filter(Boolean),
    certificate_id: String(r.certificateId || ''),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = coreKey(keyword);
    if (!wanted) return CANNOT('other', PUBLIC_PAGE, 'empty company name');

    // Query 1: the name as typed minus its legal form, punctuation kept. Query 2 (only if needed): the bare words.
    const queries = [coreText(keyword) || String(keyword).trim()];
    const bare = words(queries[0]).join(' ');
    if (bare && bare !== queries[0]) queries.push(bare);

    const seen = [];
    for (const q of queries) {
      const r = await search(q);
      if (r.kind === 'fail') return CANNOT(r.reason, PUBLIC_PAGE, `${r.excerpt} (query "${q}")`);
      if (r.kind === 'empty') continue;

      const matches = r.rows.filter((row) => coreKey(row.organisationName) === wanted);
      if (matches.length) {
        const records = matches.map(toRecord);
        const name = records[0].name;
        return {
          status: 'found',
          reason: '',
          records,
          source_url: PUBLIC_PAGE,
          excerpt: `${records.length} certificate record(s) for "${name}" on the JAS-ANZ register; statuses: ${[...new Set(records.map((x) => x.status))].join(', ')}`,
        };
      }
      if (r.count > r.rows.length) {
        // The site has more matching rows than this request returned, and none of them is an exact match here.
        return CANNOT('other', PUBLIC_PAGE, `the search returned ${r.count} rows, only ${r.rows.length} were read; no exact match in them (query "${q}")`);
      }
      for (const row of r.rows) {
        const n = String(row.organisationName || '').trim();
        if (n && !seen.includes(n) && seen.length < 5) seen.push(n);
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PUBLIC_PAGE,
      excerpt: seen.length
        ? `no certified organisation with this name; similar names on the register: ${seen.join('; ')}`
        : `no certified organisation found for "${keyword}" (JASANZ_RECORDS_NOT_FOUND)`,
    };
  } catch (err) {
    return CANNOT('other', PUBLIC_PAGE, String(err?.message || err).slice(0, 300));
  }
}
