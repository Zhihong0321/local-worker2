export const meta = {
  task: 'TW-announcement.mol.gov.tw',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'representative', 'authority', 'announce_date', 'decision_date', 'case_no', 'law', 'regulations', 'violations', 'fine', 'remarks', 'columns'],
  canary: { found: '泰興電子股份有限公司', not_found: '不存在測試股份有限公司' },
};

const BASE = 'https://announcement.mol.gov.tw/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEADLINE_MS = 45000;  // the whole lookup stays well under the 60 s limit
const MAX_REQUESTS = 12;    // the site shows a captcha after many searches; keep the number of requests small
const PH = '￿';        // stands for the site's "?", a character the site could not store

/** Plain text of an HTML fragment: <br> becomes " / ", tags are removed, a few entities decoded. */
function clean(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
}

/** Normalised form for comparing names: width and case folded, 臺 read as 台, spaces and punctuation removed. */
function normName(s) {
  return (s || '')
    .normalize('NFKC')
    .replace(/\?/g, PH)
    .replace(/臺/g, '台')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** True when the site's name (where "?" marks an unknown character) is the same company as the typed name. */
function sameName(siteName, typedNorm) {
  const siteNorm = normName(siteName);
  if (!siteNorm || !typedNorm) return false;
  const pattern = siteNorm.split(PH).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.');
  return new RegExp('^' + pattern + '$', 'u').test(typedNorm);
}

/** Every result table on the page (table1..table5): header names, rows and page count ("共N頁" sits after </table>). */
function parseTables(html) {
  const tables = [];
  for (const m of html.matchAll(/<table class="table[^"]*" id="(table\d)">([\s\S]*?)(?=<table class="table|$)/g)) {
    const body = m[2];
    const headers = [...(body.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] || '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
      .map(x => clean(x[1]));
    const tbody = body.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
    const rows = [];
    for (const r of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => clean(c[1]));
      if (cells.length === 0 || cells.join('').includes('查無資料')) continue;
      rows.push(cells);
    }
    const pages = Number(body.match(/共(\d+)頁/)?.[1]);
    tables.push({ id: m[1], caption: clean(body.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1]), headers, rows,
                  pages: Number.isFinite(pages) ? pages : null });
  }
  return tables;
}

/** One record from one table row; the header names say which column is which. */
function toRecord(table, cells) {
  const columns = {};
  table.headers.forEach((h, i) => { if (h && i < cells.length) columns[h] = cells[i]; });
  const pick = re => { const i = table.headers.findIndex(h => re.test(h)); return i >= 0 ? (cells[i] || '') : ''; };
  const nameRaw = pick(/事業單位名稱|自然人姓名/);
  const cut = nameRaw.search(/[(（]/);
  return {
    name: (cut >= 0 ? nameRaw.slice(0, cut) : nameRaw).trim(),
    representative: cut >= 0 ? nameRaw.slice(cut).replace(/^[(（]|[)）]$/g, '').trim() : '',
    authority: pick(/縣市|單位別/),
    announce_date: pick(/公告日期/),
    decision_date: pick(/處分日期/),
    case_no: pick(/處分字號/),
    law: table.caption,
    regulations: pick(/違法法規法條/),
    violations: pick(/違反法規內容/),
    fine: pick(/罰鍰金額|處分金額/),
    remarks: pick(/備註/),
    columns,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const jar = new Map();
  let requests = 0;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: BASE,
                                       excerpt: String(excerpt || '').slice(0, 500) });
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keepCookies = (res) => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const line of raw) {
      const kv = line.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  };
  const request = (url, init = {}) => {
    requests++;
    return fetch(url, { ...init, headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
                                            'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5', 'Cookie': cookieHeader() },
                        signal: AbortSignal.timeout(25000) }).then(res => { keepCookies(res); return res; });
  };
  const badStatus = (res) => (res.status === 403 || res.status === 429)
    ? fail('blocked', `HTTP ${res.status}`) : fail('http_error', `HTTP ${res.status}`);
  // A page with no result tables is either the bot check (captcha) or something unexpected.
  const noTables = (html) => /請輸入驗證碼|captcha/i.test(html)
    ? fail('blocked', 'the site shows a captcha / bot check instead of results')
    : fail('layout_changed', html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));

  try {
    const typed = normName(keyword);
    if (!typed) return fail('other', 'empty company name');

    // Step 1: the search page gives a session cookie and the form's CSRF token.
    const home = await request(BASE);
    if (!home.ok) return badStatus(home);
    const homeHtml = await home.text();
    const token = homeHtml.match(/name="_csrf_token" value="([^"]*)"/)?.[1];
    if (!token) return noTables(homeHtml);

    // Step 2: the search is a POST to the same address. Each result table has its own page number (Page1..Page5).
    const baseFields = { _csrf_token: token, CITYNO: '', UNITNAME: keyword, REGNUMBER: '', REGNO: '', FINE: '',
                         DOCstartDate: '', DOCEndDate: '', Page1: '1', Page2: '1', Page3: '1', Page4: '1', Page5: '1' };
    const post = (page) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries({ ...baseFields, ...page })) fd.append(k, v);
      return request(BASE, { method: 'POST', body: fd });
    };

    const first = await post({});
    if (!first.ok) return badStatus(first);
    const firstHtml = await first.text();
    const summary = clean(firstHtml.match(/<span>(依上述查詢條件[\s\S]*?)<\/span>/)?.[1]);
    const tables = parseTables(firstHtml);
    const ids = ['table1', 'table2', 'table3', 'table4', 'table5'];
    if (!summary || !ids.every(id => tables.some(t => t.id === id && t.pages !== null))) return noTables(firstHtml);

    // Step 3: read the further pages of each table, within the request and time limits.
    let complete = true;
    const readPages = {};
    for (const t of tables) {
      readPages[t.id] = t.pages > 0 ? 1 : 0;
      const n = t.id.replace('table', '');
      for (let p = 2; p <= t.pages; p++) {
        if (requests >= MAX_REQUESTS || Date.now() - started > DEADLINE_MS) { complete = false; break; }
        const res = await post({ [`Page${n}`]: String(p) });
        if (!res.ok) return badStatus(res);
        const html = await res.text();
        const page = parseTables(html).find(x => x.id === t.id);
        if (!page) return noTables(html);
        t.rows.push(...page.rows);
        readPages[t.id] = p;
      }
    }

    // Step 4: keep only rows whose company name is the typed company, not just a name that contains the same words.
    const records = [];
    for (const t of tables) for (const cells of t.rows) {
      const rec = toRecord(t, cells);
      if (sameName(rec.name, typed)) records.push(rec);
    }

    if (records.length > 0) {
      const top = records[0];
      return {
        status: 'found', reason: '', records, source_url: BASE,
        excerpt: (`${top.law} | ${top.name} | ${top.case_no} | ${top.decision_date} | ${top.fine}`.slice(0, 460)
                  + (complete ? '' : ' [partial: some result pages were not read]')),
      };
    }
    if (!complete) return fail('timeout', `no exact match in the pages read before the limit: ${JSON.stringify(readPages)}`);
    return {
      status: 'not_found', reason: '', records: [], source_url: BASE,
      excerpt: `${summary} No result row has this exact company name in the 5 result tables.`.slice(0, 480),
    };
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(aborted ? 'timeout' : 'other', String(err?.message || err));
  }
}
