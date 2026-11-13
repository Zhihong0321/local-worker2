export const meta = {
  task: 'VN-muasamcong.mpi.gov.vn',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['contractorCode', 'contractorName', 'reasonType', 'reason', 'decisionNo', 'status', 'publishDate', 'bannedTime', 'expDate', 'bidNo', 'bidName', 'notifyNo', 'planNo', 'planName'],
  canary: { found: 'CÔNG TY TNHH THƯƠNG MẠI H.B.C', not_found: 'CÔNG TY TNHH MỘT THÀNH VIÊN ZZQX KHÔNG TỒN TẠI' },
};

// Scope: this handler reads the national list of organisations/contractors sanctioned for tender violations
// (site section "organizations-violators", contractor tabs). It does NOT read bid history or contract values.
const PAGE = 'https://muasamcong.mof.gov.vn/web/guest/organizations-violators';
const API = 'https://muasamcong.mof.gov.vn/o/egp-portal-org-ind-violating/services/contractor-violate/on-search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Two tabs of the same list: reason types 1,4,5 and 2,3 (the online quotation tab).
const REASON_SETS = [[1, 4, 5], [2, 3]];
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

// Legal-form words removed before comparing (Vietnamese and common English forms).
const LEGAL_WORDS = new Set([
  'cong', 'ty', 'tnhh', 'co', 'phan', 'cp', 'mot', 'thanh', 'vien', 'tm', 'dv', 'sdn', 'bhd', 'ltd', 'limited',
  'jsc', 'llc', 'pte', 'company', 'corp', 'corporation', 'doanh', 'nghiep', 'tu', 'nhan', 'hop', 'danh', 'va',
]);

/** Lowercase, drop diacritics, punctuation and legal-form words; returns the core name as one string. */
function core(str) {
  const words = (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.filter((w) => !LEGAL_WORDS.has(w)).join('');
}

function headers() {
  return {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Referer': PAGE,
    'Origin': 'https://muasamcong.mof.gov.vn',
  };
}

/** Read every page of one reason set. Returns { rows } or { fail: {reason, excerpt} }. */
async function readList(reasonTypes) {
  const rows = [];
  let total = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const body = {
      publishBy: { contains: null },
      contractorName: { contains: null },
      decisionNo: { contains: null },
      contractorCode: { equals: null },
      status: { in: ['PUBLISH', 'CANCEL'] },
      reasonType: { in: reasonTypes },
      pageSize: PAGE_SIZE,
      pageNumber,
    };
    const res = await fetch(API, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
    if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { fail: { reason: 'layout_changed', excerpt: text.slice(0, 300) } }; }
    const page = json && json.page;
    if (!page || !Array.isArray(page.content) || typeof page.totalElements !== 'number') {
      return { fail: { reason: 'layout_changed', excerpt: text.slice(0, 300) } };
    }
    total = page.totalElements;
    rows.push(...page.content);
    if (page.content.length === 0 || page.last === true || rows.length >= total) break;
    if (pageNumber === MAX_PAGES - 1) return { fail: { reason: 'other', excerpt: `list longer than ${MAX_PAGES * PAGE_SIZE} rows, read incomplete` } };
  }
  return { rows, total };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = core(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'the company name has no usable words' };
    }

    const all = [];
    for (const set of REASON_SETS) {
      const got = await readList(set);
      if (got.fail) {
        return { status: 'couldnt_check', reason: got.fail.reason, records: [], source_url: API, excerpt: got.fail.excerpt };
      }
      all.push(...got.rows);
    }

    const matches = [];
    const seen = new Set();
    for (const r of all) {
      if (core(r.contractorName) !== want) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      matches.push({
        contractorCode: r.contractorCode || '',
        contractorName: (r.contractorName || '').trim(),
        reasonType: r.reasonType || '',
        reason: String(r.reason || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        decisionNo: r.decisionNo || '',
        status: r.status || '',
        publishDate: r.publishDate || '',
        bannedTime: r.bannedTime ?? null,
        expDate: r.expDate || '',
        bidNo: r.bidNo || '',
        bidName: r.bidName || '',
        notifyNo: r.notifyNo || '',
        planNo: r.planNo || '',
        planName: r.planName || '',
      });
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `No match on the organisations-violators list (${all.length} rows read). This list covers sanctioned contractors only.`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: PAGE,
      excerpt: `${matches.length} sanctioned record(s) for "${matches[0].contractorName}" on the organisations-violators list`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: API, excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
