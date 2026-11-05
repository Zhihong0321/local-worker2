/**
 * KR-ktc.re.kr / w1 — KTC (Korea Testing Certification Institute)
 *
 * The public customer portal https://cs.ktc.re.kr is a WebSquare SPA, but the
 * data it shows comes from open JSON endpoints that the page itself calls:
 *
 *   1) POST https://cs.ktc.re.kr/api/v1/cma/entrps/entrps-popup-list
 *      -> company search ("업체정보 조회" popup, PGE_CMY_00048 / DTS_CMY_00121)
 *         body: {entrpsSe:"SAFE_CRTFC_ENTRPS_NM_EXTEND", entrpsVal:<name>, ...}
 *         returns company rows with entrpsSn (company serial), bizno, address.
 *
 *   2) POST https://cs.ktc.re.kr/api/v1/tsg/entrexpsr/select-crtfc-sttus
 *      -> "전기용품 안전인증/안전확인 현황 조회" (PGE_TSG_00006 / DTS_TSG_00018)
 *         body: {searchDiv:"1", entrpsSn:<sn>, testMlsfcCd:"ALL", ...}
 *         returns certification rows: outptCrtfcNo (cert no), prductNm,
 *         bassModelNm, crtfcDe, crtfcCanclAt ...
 *
 * Session: one GET https://cs.ktc.re.kr/ hands out the SESSION cookie the JSON
 * endpoints want; browser-ish headers (incl. Accept-Language) are required,
 * otherwise the gateway answers SYS001/SYS002 instead of data.
 */
export const meta = {
  task: 'KR-ktc.re.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'cert_no', 'product', 'model', 'cert_date', 'state'],
  canary: { found: '(주)귀뚜라미-청도공장', not_found: '세무법인 혜움' },
};

const BASE = 'https://cs.ktc.re.kr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIN_GAP_MS = 1100; // at most ~1 request/second to the site
const MAX_COMPANIES = 8; // company rows to expand into certificate queries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let jar = {};
let lastAt = 0;

function cookieHeader() {
  const parts = Object.entries(jar).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join('; ') : '';
}

function rememberCookies(res) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else if (res.headers.get('set-cookie')) list = [res.headers.get('set-cookie')];
  for (const raw of list) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
}

async function hit(path, init = {}) {
  const wait = MIN_GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const headers = Object.assign({}, init.headers);
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, {
    ...init,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  rememberCookies(res);
  return res;
}

const API_HEADERS = {
  'content-type': 'application/json;charset=UTF-8',
  accept: 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'x-portalid': 'PORTAL3',
  'x-requested-with': 'XMLHttpRequest',
  referer: BASE + '/',
  origin: BASE,
};

function isApiError(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.code === 'string' && obj.code.startsWith('SYS');
}

function snippet(obj, n = 500) {
  let text;
  try {
    text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch {
    text = String(obj);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, n) : text;
}

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '-') return String(v).trim();
  }
  return '';
}

/** Search the portal's company table by name. Returns company rows. */
async function findCompanies(keyword) {
  const res = await hit('/api/v1/cma/entrps/entrps-popup-list', {
    method: 'POST',
    headers: { ...API_HEADERS, 'x-pageid': 'PGE_CMY_00048', 'x-dataserviceid': 'DTS_CMY_00121' },
    body: JSON.stringify({
      entrpsSe: 'SAFE_CRTFC_ENTRPS_NM_EXTEND',
      entrpsVal: keyword,
      currentPage: '1',
      pagePerCount: '50',
      safeCrtfcAt: 'Y',
    }),
  });
  const text = await res.text();
  if (res.status !== 200) return { error: 'http_error', detail: `company search HTTP ${res.status}` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'layout_changed', detail: 'company search did not return JSON' };
  }
  if (isApiError(data)) return { error: 'other', detail: `company search ${data.code}` };
  if (!Array.isArray(data)) return { error: 'layout_changed', detail: 'company search result is not a list' };
  const rows = data.filter((r) => r && typeof r === 'object' && pick(r, 'entrpsSn'));
  if (data.length > 0 && rows.length === 0) {
    return { error: 'layout_changed', detail: 'company search rows carry no entrpsSn' };
  }
  return { companies: rows };
}

/** Certifications held by one company serial number. */
async function findCertificates(entrpsSn) {
  const res = await hit('/api/v1/tsg/entrexpsr/select-crtfc-sttus', {
    method: 'POST',
    headers: { ...API_HEADERS, 'x-pageid': 'PGE_TSG_00006', 'x-dataserviceid': 'DTS_TSG_00018' },
    body: JSON.stringify({
      searchDiv: '1',
      entrpsSn,
      currentPage: '1',
      pagePerCount: '20',
      excelDownAt: 'N',
      testMlsfcCd: 'ALL',
    }),
  });
  const text = await res.text();
  if (res.status !== 200) return { error: 'http_error', detail: `cert search HTTP ${res.status}` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'layout_changed', detail: 'cert search did not return JSON' };
  }
  if (isApiError(data)) return { error: 'other', detail: `cert search ${data.code}` };
  if (!data || typeof data !== 'object' || !Array.isArray(data.result)) {
    return { error: 'layout_changed', detail: 'cert search has no "result" list' };
  }
  return { records: data.result };
}

export default async function lookup(keyword) {
  jar = {};
  lastAt = 0;
  const name = String(keyword == null ? '' : keyword).trim();
  const empty = (reason, detail, excerpt) => ({
    status: 'couldnt_check',
    reason,
    records: [],
    source_url: BASE + '/',
    excerpt: excerpt || detail || '',
  });
  if (!name) return empty('other', 'empty company name');

  try {
    // Session cookie (the JSON endpoints below need it).
    const home = await hit('/', {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    if (home.status !== 200) {
      return empty(home.status === 401 || home.status === 403 ? 'blocked' : 'http_error', `portal home HTTP ${home.status}`);
    }

    const comp = await findCompanies(name);
    if (comp.error) {
      return empty(comp.error, comp.detail);
    }
    if (comp.companies.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE + '/api/v1/cma/entrps/entrps-popup-list',
        excerpt: `업체정보 조회 "${name}" -> 0 companies`,
      };
    }

    // Prefer exact / prefix matches so a generic name does not spend the budget on relatives.
    const norm = (s) => s.replace(/\(주\)|㈜|주식회사|\s+/g, '');
    const target = norm(name);
    const rank = (r) => {
      const n = norm(pick(r, 'entrpsNm'));
      if (n === target) return 0;
      if (n.startsWith(target)) return 1;
      if (n.includes(target)) return 2;
      return 3;
    };
    const sorted = [...comp.companies].sort((a, b) => rank(a) - rank(b));
    const seen = new Set();
    const queue = [];
    for (const c of sorted) {
      const sn = pick(c, 'entrpsSn');
      if (!sn || seen.has(sn)) continue;
      seen.add(sn);
      queue.push(c);
      if (queue.length >= MAX_COMPANIES) break;
    }

    const records = [];
    let total = 0;
    let matchedCompanies = [];
    let certErrors = [];
    for (const c of queue) {
      const sn = pick(c, 'entrpsSn');
      const cert = await findCertificates(sn);
      if (cert.error) {
        certErrors.push(cert.detail);
        continue;
      }
      if (cert.records.length === 0) continue;
      matchedCompanies.push(pick(c, 'entrpsNm'));
      total += Number(pick(cert.records[0], 'totalCount')) || cert.records.length;
      for (const r of cert.records) {
        records.push({
          name: pick(r, 'mnftEntrpsNm', 'reqestEntrpsNm') || pick(c, 'entrpsNm'),
          cert_no: pick(r, 'outptCrtfcNo'),
          product: pick(r, 'prductNm'),
          model: pick(r, 'bassModelNm'),
          cert_date: pick(r, 'crtfcDe', 'frstCrtfcDe'),
          state: pick(r, 'crtfcCanclAt', 'crtfcCanclSeCd'),
          bizno: pick(r, 'bizno') || pick(c, 'bizno'),
        });
      }
    }

    if (records.length === 0 && certErrors.length === queue.length && queue.length > 0) {
      return empty('layout_changed', certErrors[0]);
    }
    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE + '/api/v1/tsg/entrexpsr/select-crtfc-sttus',
        excerpt: `company ${matchedCompanies.length ? matchedCompanies.join(', ') : queue.map((c) => pick(c, 'entrpsNm')).join(', ')} -> no KTC certification record`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: BASE + '/api/v1/tsg/entrexpsr/select-crtfc-sttus',
      excerpt: snippet({
        query: name,
        companies: matchedCompanies,
        total_reported: total,
        first: records[0],
      }),
    };
  } catch (err) {
    const msg = err && err.name === 'TimeoutError' ? 'timeout' : 'other';
    return empty(msg, `request failed: ${err && err.message ? err.message : String(err)}`);
  }
}
