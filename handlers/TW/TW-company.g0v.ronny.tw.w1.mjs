export const meta = {
  task: 'TW-company.g0v.ronny.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registry', 'uid', 'status', 'address', 'representative', 'capital', 'registry_office', 'established', 'last_changed', 'business_items', 'detail_url'],
  canary: { found: '台灣積體電路製造股份有限公司', not_found: '不存在測試股份有限公司' },
};

const SITE = 'https://company.g0v.ronny.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;            // 10 results per page, so at most 50 results are read
const STOP_PAGING_AFTER_MS = 30000; // never start a new page request after 30 s (each fetch can take up to 25 s)
const LEGAL_FORMS = ['股份有限公司', '有限責任公司', '有限公司', '股份有限', '企業社', '公司'];

/** The name without spaces, punctuation, brackets like (股) (有), or the legal form at the end. Case is kept. */
function core(name) {
  let s = String(name || '').normalize('NFKC').replace(/[（(]\s*[股有]\s*[)）]/g, '');
  s = s.replace(/[\s\p{P}\p{S}]+/gu, '');
  let prev;
  do {
    prev = s;
    for (const form of LEGAL_FORMS) {
      if (s.length > form.length && s.endsWith(form)) { s = s.slice(0, -form.length); break; }
    }
  } while (s !== prev);
  return s;
}

const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const pad = (n) => String(n).padStart(2, '0');
function dateText(d) {
  if (!d || typeof d !== 'object' || !d.year) return '';
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** One site record -> one output record. Company registry rows have 公司名稱; business tax rows only have 商業名稱. */
function toRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const isCompany = text(r['公司名稱']) !== '';
  const name = isCompany ? text(r['公司名稱']) : text(r['商業名稱']);
  if (!name) return null;
  const uid = String(r['統一編號'] ?? '').trim();
  return {
    name,
    registry: isCompany ? 'company' : 'business_tax',
    uid,
    status: text(r['公司狀況'] ?? r['現況']),
    address: text(r['公司所在地'] ?? r['地址']),
    representative: text(r['代表人姓名'] ?? r['負責人姓名']),
    capital: text(r['資本總額(元)'] ?? r['資本額(元)']),
    registry_office: text(r['登記機關']),
    established: dateText(r['核准設立日期']),
    last_changed: dateText(r['最後核准變更日期'] ?? r['最近異動日期']),
    business_items: Array.isArray(r['所營事業資料'])
      ? r['所營事業資料'].map((p) => (Array.isArray(p) ? p.join(' ') : String(p)))
      : [],
    detail_url: isCompany && uid ? `${SITE}/id/${uid}` : '',
  };
}

/** Fetch one JSON search page; returns { json } or { fail, excerpt }. */
async function getSearchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { json = null; }
  if (!json || !Array.isArray(json.data) || typeof json.found !== 'number') {
    if (/captcha|cf-chl|challenge-platform|verify you are human/i.test(body)) return { fail: 'blocked', excerpt: 'bot check page' };
    return { fail: 'layout_changed', excerpt: body.slice(0, 200) };
  }
  return { json };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let pageUrl = `${SITE}/`;
  try {
    const shown = String(keyword ?? '').trim();
    const term = core(shown);
    pageUrl = `${SITE}/index/search?q=${encodeURIComponent(term)}`;
    if (term.length < 2) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: 'name has no company part to search for' };
    }
    // The registry is indexed by Chinese name only; an English-only name missing from it proves nothing.
    if (!/[㐀-鿿]/.test(term)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: 'name has no Chinese characters; this site is searched by Chinese company name only' };
    }

    const wanted = term.toLowerCase();
    const records = [];
    let total = null;
    let read = 0;
    let apiUrl = '';
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (total !== null && read >= total) break;
      if (page > 1 && Date.now() - started > STOP_PAGING_AFTER_MS) break;
      apiUrl = `${SITE}/api/search?q=${encodeURIComponent(term)}&page=${page}`;
      const got = await getSearchPage(apiUrl);
      if (got.fail) {
        return { status: 'couldnt_check', reason: got.fail, records: [], source_url: pageUrl, excerpt: got.excerpt };
      }
      if (total === null) total = got.json.found;
      if (got.json.data.length === 0) break;
      read += got.json.data.length;
      for (const r of got.json.data) {
        const rec = toRecord(r);
        if (rec && core(rec.name).toLowerCase() === wanted) records.push(rec);
      }
    }

    if (records.length > 0) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: pageUrl,
        excerpt: `${records.length} matching record(s) for "${term}". ${first.name} | ${first.uid} | ${first.status} | ${first.address}`.slice(0, 500),
      };
    }

    const truncated = total === null || read < total;
    if (truncated) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: pageUrl,
        excerpt: `read ${read} of ${total} search results for "${term}" and none matched; the rest were not read, so the company cannot be ruled out`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: `${total} results for "${term}" (${apiUrl}); no company name matched`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: pageUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
