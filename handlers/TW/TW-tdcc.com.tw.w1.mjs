export const meta = { task: 'TW-tdcc.com.tw', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'stock_code', 'data_date', 'distribution'],
  canary: { found: '台積電', not_found: '不存在科技股份有限公司' } };

// The TDCC equity dispersion query (zh page) searches by the listed security name (證券名稱, the short name the
// exchange uses) or by securities code. It needs a one-time SYNCHRONIZER_TOKEN from a fresh GET of the form.
// Each token works for one POST only, so every search does its own GET first.
const BASE = 'https://www.tdcc.com.tw';
const FORM_URL = BASE + '/portal/zh/smWeb/qryStock';
const AJAX_URL = BASE + '/portal/smWeb/qryStockAjax';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NO_DATA = '查無此資料';
const BUDGET_MS = 40000;

function fail(reason, excerpt, url) {
  return { status: 'couldnt_check', reason, records: [], source_url: url || FORM_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Comparison key: case, spaces and punctuation ignored, full-width folded to half-width. */
function normalize(s) {
  return String(s || '').normalize('NFKC').toUpperCase().replace(/[\s.,'"()\-_/&·]+/g, '');
}

/** Drop a trailing Taiwan or English legal form ("股份有限公司", "CO., LTD.", ...). */
function stripLegal(name) {
  let s = String(name || '').normalize('NFKC').trim();
  s = s.replace(/[\s,.]*\b(co\.?,?\s*ltd\.?|ltd\.?|limited|inc\.?|corp\.?|corporation|co\.?)\s*$/i, '');
  s = s.replace(/\s*(股份有限公司|有限公司|股份有限|公司)$/, '');
  return s.replace(/\s+/g, '').trim();
}

/** The same transform the page's own submit handler applies to the name box before posting. */
function siteName(s) {
  return s.toUpperCase().replace(/(SCRIPT|ALERT|SELECT|INSERT|UPDATE|[ <>&%;"'])/gi, '');
}

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  return list.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
}

function blockedWords(html) {
  return /captcha|驗證碼|reCAPTCHA|Access Denied|Forbidden|防火牆|請稍後再試/i.test(html);
}

function errReason(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

/** Fresh GET of the form: one-time token, session cookie and the latest data date. */
async function openForm() {
  const res = await fetch(FORM_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', `HTTP ${res.status} on the query form`) };
  if (!res.ok) return { fail: fail('http_error', `HTTP ${res.status} on the query form`) };
  const html = await res.text();
  const token = (html.match(/name="SYNCHRONIZER_TOKEN" value="([^"]+)"/) || [])[1];
  const date = (html.match(/name="firDate" value="(\d{8})"/) || [])[1] || (html.match(/<option value="(\d{8})"/) || [])[1];
  if (!token || !date) {
    if (blockedWords(html)) return { fail: fail('blocked', 'query form shows a bot or login check') };
    return { fail: fail('layout_changed', 'query form has no token or date: ' + html.slice(0, 200)) };
  }
  return { token, date, cookie: cookiesFrom(res) };
}

/** One POST of the form searching by security name. Returns {nodata} | {found} | {fail}. */
async function search(name, form) {
  const body = new URLSearchParams({
    SYNCHRONIZER_TOKEN: form.token, SYNCHRONIZER_URI: '/portal/zh/smWeb/qryStock', method: 'submit',
    firDate: form.date, scaDate: form.date, sqlMethod: 'StockName', stockNo: '', stockName: siteName(name),
  });
  const res = await fetch(FORM_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': form.cookie,
      'Referer': FORM_URL, 'Origin': BASE, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', `HTTP ${res.status} on search`) };
  if (!res.ok) return { fail: fail('http_error', `HTTP ${res.status} on search`) };
  const html = await res.text();
  if (html.includes(NO_DATA)) return { nodata: true };

  const code = ((html.match(/證券代號：([^<\n]*)/) || [])[1] || '').trim();
  const listed = ((html.match(/證券名稱：([^<\n]*)/) || [])[1] || '').trim();
  const dateRaw = ((html.match(/資料日期：([^<\n]*)/) || [])[1] || '').trim();
  if (!code || !listed) {
    if (blockedWords(html)) return { fail: fail('blocked', 'search result shows a bot or login check') };
    return { fail: fail('layout_changed', 'search result has no 證券代號/證券名稱: ' + html.slice(0, 200), FORM_URL) };
  }
  const rows = [];
  const rowRe = /<tr>\s*<td align="center">([^<]*)<\/td>\s*<td align="center">([^<]*)<\/td>\s*<td align="right">([^<]*)<\/td>\s*<td align="right">([^<]*)<\/td>\s*<td align="right">([^<]*)<\/td>\s*<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    rows.push({ no: m[1].trim(), bracket: m[2].trim(), holders: m[3].trim(), shares: m[4].trim(), percent: m[5].trim() });
  }
  if (rows.length === 0) return { fail: fail('layout_changed', 'search result has no distribution rows for ' + code) };
  return { found: { code, listed, dateRaw, rows } };
}

/** ROC date "115年11月06日" -> "2026-11-06". Returns the raw text if it does not parse. */
function isoDate(raw) {
  const m = String(raw).match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return raw;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** Second, separate check on the same site: does its name list hold this exact name? Returns true/false, or null if it cannot tell. */
async function listHasName(name, date) {
  const url = `${AJAX_URL}?REQ_OPR=qryStockName&scaDate=${date}&query=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) return null;
  let json;
  try { json = JSON.parse(await res.text()); } catch { return null; }
  if (!json || !Array.isArray(json.suggestions)) return null;
  return json.suggestions.some((s) => normalize(s) === normalize(name));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword ?? '').normalize('NFKC').trim();
    if (!kw) return fail('other', 'empty keyword');
    // Try the name without its legal form first (the listed name usually has none), then the name as typed.
    const candidates = [...new Set([stripLegal(kw), kw.replace(/\s+/g, '')])].filter(Boolean);
    if (candidates.length === 0) return fail('other', 'no name left after removing the legal form');

    let date = null;
    for (const cand of candidates) {
      if (Date.now() - started > BUDGET_MS) return fail('timeout', `stopped after ${BUDGET_MS / 1000} s`);
      const form = await openForm();
      if (form.fail) return form.fail;
      date = form.date;
      const r = await search(cand, form);
      if (r.fail) return r.fail;
      if (r.nodata) continue;

      const { code, listed, dateRaw, rows } = r.found;
      if (normalize(listed) !== normalize(cand)) {
        return fail('layout_changed', `search for "${cand}" returned a different security: "${listed}"`);
      }
      const dataDate = isoDate(dateRaw);
      return {
        status: 'found',
        reason: '',
        records: [{ name: listed, stock_code: code, data_date: dataDate, distribution: rows }],
        source_url: FORM_URL,
        excerpt: `證券代號：${code}  證券名稱：${listed}  資料日期：${dateRaw}  (${rows.length} rows)`,
      };
    }

    // Every candidate got the site's normal "查無此資料" answer. Before calling it not_found, confirm the
    // site's own name list does not hold the name either; if it does, the search answer is not trusted.
    for (const cand of candidates) {
      if (Date.now() - started > BUDGET_MS) return fail('timeout', `stopped after ${BUDGET_MS / 1000} s`);
      const has = await listHasName(cand, date);
      if (has === null) return fail('other', `could not confirm "${cand}" against the site's name list`, AJAX_URL);
      if (has) return fail('other', `the name list has "${cand}" but the search returned no data`, FORM_URL);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: FORM_URL,
      excerpt: `查無此資料 for ${candidates.map((c) => `"${c}"`).join(', ')}; the site's name list has no exact match`,
    };
  } catch (err) {
    return fail(errReason(err), String(err && err.message ? err.message : err));
  }
}
