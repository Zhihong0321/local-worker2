export const meta = { task: 'VN-abei.gov.vn', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'licence_type', 'licence_number', 'status', 'registration_number', 'address', 'valid_from', 'valid_to', 'service_name'],
  canary: { found: 'Công ty TNHH Công nghệ DanaGame', not_found: 'Công ty TNHH Không Tồn Tại Zzqx Vnn' } };

// The licence lookup portal https://giayphep.abei.gov.vn (linked from abei.gov.vn) is a single-page app. Its search
// box calls this public JSON endpoint without any login or token (the request body is the portal's own filter model).
const API = 'https://gpttdt-api.abei.gov.vn/services/mcrlmtp/api/license/pivotPaging';
const PAGE = 23;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words in Vietnamese and English that are ignored when two company names are compared.
const LEGAL = new Set(['cong', 'ty', 'co', 'phan', 'tnhh', 'mtv', 'cp', 'jsc', 'ltd', 'limited', 'sdn', 'bhd', 'llc', 'corp', 'company']);

function stripMarks(s) {
  return (s || '').replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Normalised name tokens without the legal form, e.g. "Công ty TNHH Công nghệ DanaGame" -> ["nghe", "danagame"]. */
function nameTokens(s) {
  return stripMarks(s).split(/[^a-z0-9]+/).filter((t) => t && !LEGAL.has(t));
}

function sameCompany(a, b) {
  const x = nameTokens(a).join('');
  const y = nameTokens(b).join('');
  return x.length > 0 && x === y;
}

/** The typed name with its legal-form words removed, used as a second, looser search. */
function coreName(s) {
  return s.split(' ').filter((w) => !LEGAL.has(stripMarks(w).replace(/[^a-z0-9]/g, ''))).join(' ').trim();
}

function toRecord(r) {
  const d = r.licenseDetail || {};
  const a = d.headOfficeLocation || {};
  return {
    name: r.companyName || '',
    licence_type: r.platformCategoryName || '',
    licence_number: r.licenseNumber || '',
    status: r.cstatus || r.status || '',
    registration_number: r.registrationNumber || d.registrationNumber || '',
    address: [a.streetNumber, a.districtName, a.provinceName].filter(Boolean).join(', '),
    valid_from: (r.issueDate || r.validFrom || '').slice(0, 10),
    valid_to: (r.validTo || '').slice(0, 10),
    service_name: d.gameNameVietnam || d.socialNetworkName || d.domainName || d.website || '',
  };
}

/** One search, all pages, for one name string. Returns { rows } or { error, excerpt }. */
async function searchAll(filterText, started) {
  const rows = [];
  let startRow = 0;
  for (let page = 0; page < 10; page++) {
    if (Date.now() - started > 30000) return { error: 'timeout', excerpt: 'more result pages than the 60 s limit allows' };
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          startRow,
          endRow: startRow + PAGE,
          sortModel: [{ sort: 'desc', colId: 'validFrom' }],
          filterModel: { companyName: { type: 'contains', filterType: 'text', filter: filterText } },
        }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { error: timedOut ? 'timeout' : 'other', excerpt: String(err && err.message || err).slice(0, 300) };
    }
    if (res.status === 403 || res.status === 429) return { error: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { error: 'http_error', excerpt: `HTTP ${res.status}` };

    let json;
    try { json = await res.json(); } catch (e) { return { error: 'layout_changed', excerpt: 'response is not JSON' }; }
    const d = json && json.data;
    if (!d || !Array.isArray(d.data) || typeof d.lastRow !== 'number') {
      return { error: 'layout_changed', excerpt: JSON.stringify(json).slice(0, 300) };
    }
    rows.push(...d.data);
    if (d.data.length === 0 || startRow + PAGE >= d.lastRow) return { rows };
    startRow += PAGE;
  }
  return { error: 'other', excerpt: 'more than 10 pages of results' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim().replace(/\s+/g, ' ');
  try {
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty keyword' };

    const queries = [kw];
    const core = coreName(kw);
    if (core && core !== kw) queries.push(core);

    const matches = new Map();
    let rowsSeen = 0;
    for (const q of queries) {
      const r = await searchAll(q, started);
      if (r.error) return { status: 'couldnt_check', reason: r.error, records: [], source_url: API, excerpt: r.excerpt };
      rowsSeen += r.rows.length;
      for (const row of r.rows) {
        if (sameCompany(row.companyName, kw)) matches.set(`${row.id}|${row.aggId}`, row);
      }
      if (matches.size > 0) break;
    }

    if (matches.size === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: API,
        excerpt: `Site answered; ${rowsSeen} licence rows came back for "${queries.join('" / "')}", none with the company name "${kw}"`,
      };
    }

    const records = [...matches.values()].map(toRecord);
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: API,
      excerpt: records.slice(0, 3).map((x) => `${x.name} | ${x.licence_type} | ${x.licence_number} | ${x.status}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: API,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
