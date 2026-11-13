export const meta = { task: 'JP-houjin-bangou.nta.go.jp', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'corporate_number', 'furigana', 'address'],
  canary: { found: 'トヨタ自動車株式会社', not_found: '架空ゼッタイナイ株式会社' } };

const BASE = 'https://www.houjin-bangou.nta.go.jp';
const SEARCH_URL = BASE + '/kensaku-kekka.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TOKEN = 'jp.go.nta.houjin_bangou.framework.web.common.CNSFWTokenProcessor.request.token';
const FORMS = ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '相互会社'];
const PAGE_SIZE = 10;
const MAX_PAGES = 5;
const DEADLINE_MS = 45000;

function strip(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Split a name into legal form (株式会社 etc.), the bare name, and a comparison key. */
function parse(raw) {
  const s = String(raw || '').normalize('NFKC')
    .replace(/\(\s*(株|有|合同|合資|合名|相互)\s*\)/g, (_, k) => FORMS.find((f) => f.startsWith(k)))
    .replace(/\s+/g, '');
  const form = FORMS.find((f) => s.startsWith(f) || s.endsWith(f)) || '';
  const bare = form ? s.replace(form, '') : s;
  return { form, bare, full: s, key: bare.replace(/[・･\-‐－―]/g, '').toLowerCase() };
}

/** The keyword and a listed name are the same company: same bare name, and the same legal form when the keyword gives one. */
function isSame(kw, rec) {
  return kw.key !== '' && kw.key === rec.key && (!kw.form || kw.form === rec.form);
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

function cookieOf(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

function httpProblem(res) {
  if (res.status === 403 || res.status === 429) return 'blocked';
  if (!res.ok) return 'http_error';
  return null;
}

/** Open the public home page once: the session cookie and the form token come from it. */
async function session() {
  const res = await fetch(BASE + '/', { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(25000) });
  const problem = httpProblem(res);
  if (problem) return { fail: [problem, `HTTP ${res.status} on ${BASE}/`] };
  const html = await res.text();
  const token = html.match(/request\.token" value="([^"]+)"/)?.[1];
  if (!token) return { fail: ['layout_changed', html.slice(0, 300)] };
  return { cookie: cookieOf(res), token };
}

/** One result page of the name search (page is 1-based; page 1 is the plain search). */
async function searchPage(sess, text, type, page) {
  const body = new URLSearchParams({
    [TOKEN]: sess.token, houzinNmTxtf: text, houzinNmShTypeRbtn: type, searchFlg: '1', preSyousaiScreenId: 'KJSCR0101010',
    closeCkbx: '1', _closeCkbx: 'on', _kanaCkbx: 'on', _noconvCkbx: 'on', _enCkbx: 'on',
    _houzinKdCkbx: 'on', _historyCkbx: 'on', _hideCkbx: 'on', _chgYmdShTargetCkbx: 'on',
  });
  if (page > 1) body.set('viewPageNo', String(page));
  const res = await fetch(SEARCH_URL, {
    method: 'POST', body,
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sess.cookie },
    signal: AbortSignal.timeout(25000),
  });
  const problem = httpProblem(res);
  if (problem) return { fail: [problem, `HTTP ${res.status} on the name search`] };
  const html = await res.text();
  sess.token = html.match(/request\.token" value="([^"]+)"/)?.[1] || sess.token;

  const countText = html.match(/srhResult"><strong>([\d,]+)<\/strong>/)?.[1];
  const noData = html.includes('該当するデータが存在しません');
  if (!countText && !noData) {
    if (/captcha|ロボット|アクセスが集中|access denied/i.test(html)) return { fail: ['blocked', 'bot or captcha page'] };
    return { fail: ['layout_changed', html.slice(0, 300)] };
  }
  const total = countText ? Number(countText.replace(/,/g, '')) : 0;

  const rows = [];
  for (const m of html.matchAll(/<tr>\s*<th scope="row">\s*(\d{13})\s*<\/th>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    const nameCell = cells[0] || '';
    const furigana = strip(nameCell.match(/<div class="furigana">([\s\S]*?)<\/div>/)?.[1] || '');
    const name = strip(nameCell.replace(/<div class="furigana">[\s\S]*?<\/div>/, ''));
    const address = strip((cells[1] || '').replace(/<a[\s\S]*?<\/a>/g, ''));
    rows.push({ corporate_number: m[1], name, furigana, address });
  }
  if (total > 0 && rows.length === 0) return { fail: ['layout_changed', html.slice(0, 300)] };
  return { total, rows };
}

/** All pages of one query, up to MAX_PAGES and the deadline. */
async function runQuery(sess, text, type, deadline) {
  const first = await searchPage(sess, text, type, 1);
  if (first.fail) return first;
  const rows = [...first.rows];
  const pages = Math.ceil(first.total / PAGE_SIZE);
  for (let p = 2; p <= pages && p <= MAX_PAGES && Date.now() < deadline; p++) {
    const next = await searchPage(sess, text, type, p);
    if (next.fail) return next;
    rows.push(...next.rows);
  }
  return { total: first.total, rows, truncated: rows.length < first.total };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const kw = parse(keyword);
    if (!kw.bare) return failure('other', SEARCH_URL, 'no company name left in the keyword');

    const sess = await session();
    if (sess.fail) return failure(sess.fail[0], BASE + '/', sess.fail[1]);

    // Query 1: names that start with the bare name (legal form stripped, e.g. トヨタ自動車 -> トヨタ自動車株式会社).
    // Query 2: names that contain the keyword as typed (e.g. 株式会社ソニー -> 株式会社ソニーアイ).
    const queries = [
      { label: 'starts with', text: kw.bare, type: '1' },
      { label: 'contains', text: kw.full, type: '2' },
    ];
    const seen = new Map();
    const totals = [];
    let truncated = false;
    for (const q of queries) {
      const r = await runQuery(sess, q.text, q.type, deadline);
      if (r.fail) return failure(r.fail[0], SEARCH_URL, `${q.label} "${q.text}": ${r.fail[1]}`);
      totals.push(r.total);
      if (r.truncated) truncated = true;
      for (const row of r.rows) if (!seen.has(row.corporate_number)) seen.set(row.corporate_number, row);
    }

    const matches = [...seen.values()].filter((row) => isSame(kw, parse(row.name)));
    const totalsText = `site totals: starts-with ${totals[0]}, contains ${totals[1]}`;
    if (matches.length) {
      return {
        status: 'found', reason: '',
        records: matches.map((m) => ({ name: m.name, corporate_number: m.corporate_number, furigana: m.furigana, address: m.address })),
        source_url: SEARCH_URL,
        excerpt: `${matches.length} listed name(s) match "${String(keyword).trim()}"; ${totalsText}`,
      };
    }
    if (truncated) {
      return failure('other', SEARCH_URL, `no exact match in the first ${MAX_PAGES} result pages of each search; ${totalsText}`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
      excerpt: `no listed name matches "${String(keyword).trim()}"; ${totalsText}` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(timeout ? 'timeout' : 'other', SEARCH_URL, String(err?.message || err));
  }
}
