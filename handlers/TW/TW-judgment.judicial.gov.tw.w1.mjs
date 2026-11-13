export const meta = {
  task: 'TW-judgment.judicial.gov.tw',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'case_title', 'date', 'date_roc', 'cause', 'judgment_url'],
  canary: { found: '台灣積體電路製造股份有限公司', not_found: '虛構甲乙丙科技股份有限公司' },
};

const BASE = 'https://judgment.judicial.gov.tw/FJUD/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BUDGET_MS = 55000; // the whole call must finish in under 60 s

/* ---------- name normalising ---------- */

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function plain(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Split a company name into a comparable core and a legal-form token. */
function parseName(raw) {
  let s = String(raw || '').normalize('NFKC').toLowerCase().replace(/臺/g, '台').trim();
  // English legal forms, checked on the spaced/punctuated string so "Co., Ltd." is seen as one form
  let form = '';
  const en = s.match(/[\s.,]((co\.?,?\s*ltd\.?)|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|company|sdn\.?\s*bhd\.?|pte\.?\s*ltd\.?|llc)\s*$/);
  if (en) {
    const f = en[1].replace(/[\s.,]/g, '');
    form = /^(co)?ltd$|^limited$/.test(f) ? 'ltd' : /^inc/.test(f) ? 'inc' : /^corp/.test(f) ? 'corp'
      : /^sdnbhd$/.test(f) ? 'sdnbhd' : /^pteltd$/.test(f) ? 'pteltd' : f;
    s = s.slice(0, en.index);
  }
  const core0 = s.replace(/[^\p{L}\p{N}]/gu, '');
  let core = core0;
  if (!form) {
    if (core.endsWith('股份有限公司')) { form = '股份有限公司'; core = core.slice(0, -6); }
    else if (core.endsWith('有限公司')) { form = '有限公司'; core = core.slice(0, -4); }
    else if (core.endsWith('分公司')) { form = '分公司'; core = core.slice(0, -3); }
    else if (core.endsWith('公司')) { core = core.slice(0, -2); } // generic word, no legal form
  }
  return { core, form };
}

/** The name as it appears in a text, reduced to letters and digits (the text may hold the name inside a sentence). */
function squash(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/臺/g, '台').replace(/[^\p{L}\p{N}]/gu, '');
}

/** True when the company name (legal form included, as typed) appears in the text. */
function containsName(text, name) {
  const k = squash(name);
  return k.length > 0 && squash(text).includes(k);
}

/** True when the two names are the same company: same core, and the same legal form
 *  (a missing legal form on either side is allowed). */
function sameCompany(a, b) {
  const x = parseName(a);
  const y = parseName(b);
  if (!x.core || x.core !== y.core) return false;
  return !x.form || !y.form || x.form === y.form;
}

/* ---------- HTTP helpers ---------- */

class Stop extends Error {
  constructor(status, reason, excerpt, url) {
    super(excerpt);
    this.status = status;
    this.reason = reason;
    this.excerpt = excerpt;
    this.url = url;
  }
}

function makeFetch(deadline) {
  const cookies = new Map();
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const remember = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  async function go(url, init, label) {
    const left = Math.max(1000, deadline - Date.now());
    const signal = AbortSignal.any([AbortSignal.timeout(25000), AbortSignal.timeout(left)]);
    const headers = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', Referer: BASE + 'default.aspx', ...(init.headers || {}) };
    if (cookies.size) headers.Cookie = cookieHeader();
    let res;
    try {
      res = await fetch(url, { ...init, headers, redirect: 'manual', signal });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new Stop(0, timedOut ? 'timeout' : 'other', `${label}: ${timedOut ? 'no answer in time' : String(e?.message || e).slice(0, 200)}`, url);
    }
    remember(res);
    const text = await res.text();
    if (res.status === 403 || res.status === 429) throw new Stop(res.status, 'blocked', `${label}: HTTP ${res.status}`, url);
    if (/captcha|cf-chl|checking your browser/i.test(text)) throw new Stop(res.status, 'blocked', `${label}: bot or captcha check page`, url);
    if (res.status !== 200) throw new Stop(res.status, 'http_error', `${label}: HTTP ${res.status}${res.headers.get('location') ? ' -> ' + res.headers.get('location') : ''}`, url);
    return text;
  }
  return go;
}

/* ---------- parsing ---------- */

function parseRows(html) {
  const rows = [];
  let current = null;
  for (const chunk of html.split('<tr')) {
    if (chunk.includes('id="hlTitle"')) {
      const a = chunk.match(/<a id="hlTitle"[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const d = chunk.match(/<\/td>\s*<td>\s*([\d.]+)\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/);
      if (!a) continue;
      current = {
        case_title: plain(a[2]),
        judgment_url: new URL(decode(a[1]), BASE).href,
        date_roc: d ? d[1] : '',
        cause: d ? plain(d[2]) : '',
        snippet: '',
        highlights: [],
      };
      rows.push(current);
    } else if (chunk.startsWith(' class="summary"') && current) {
      const body = chunk.slice(chunk.indexOf('>') + 1);
      current.snippet = plain(body);
      current.highlights = [...body.matchAll(/<span class="highlight">([^<]*)<\/span>/g)].map((m) => plain(m[1]));
      current = null;
    }
  }
  return rows;
}

function isoFromRoc(roc) {
  const m = String(roc).match(/^(\d{2,3})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return '';
  return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/* ---------- the lookup ---------- */

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const deadline = Date.now() + BUDGET_MS;
  try {
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty keyword' };
    const go = makeFetch(deadline);

    // 1. the search page: sets the session cookie and the ASP.NET form tokens
    const page = await go(BASE + 'default.aspx', { method: 'GET' }, 'search page');
    const field = (name) => (page.match(new RegExp(`id="${name}" value="([^"]*)"`)) || [])[1];
    const viewState = field('__VIEWSTATE');
    const viewGen = field('__VIEWSTATEGENERATOR');
    const eventVal = field('__EVENTVALIDATION');
    if (viewState === undefined || eventVal === undefined || !page.includes('txtKW')) {
      throw new Stop(200, 'layout_changed', 'search form not found on ' + BASE + 'default.aspx', BASE + 'default.aspx');
    }

    // 2. the search itself: a form POST, the site answers with the result frame
    const body = new URLSearchParams({
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewGen || '',
      __VIEWSTATEENCRYPTED: '',
      __EVENTVALIDATION: eventVal,
      txtKW: kw,
      judtype: 'JUDBOOK',
      whosub: '0',
      'ctl00$cp_content$btnSimpleQry': '送出查詢',
    });
    const searchHtml = await go(BASE + 'default.aspx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, 'search');

    const total = Number((searchHtml.match(/查詢結果<span class="badge">(\d+)/) || [])[1]);
    const frame = (searchHtml.match(/<iframe src="([^"]*)"[^>]*id="iframe-data"/) || [])[1] || '';
    const frameDecoded = decode(frame);

    // "查無資料" (no data) is the site's own answer for zero matches
    if (/ErrorPage\.aspx\?.*err=Q003/.test(frameDecoded) || total === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE + 'default.aspx',
        excerpt: `系統訊息：查無資料（search for ${kw}）`,
      };
    }
    const listMatch = frameDecoded.match(/qryresultlst\.aspx\?ty=JUDBOOK&q=[0-9a-f]+/i);
    if (!listMatch) {
      if (/ErrorPage\.aspx/.test(frameDecoded)) {
        const code = (frameDecoded.match(/err=([A-Za-z0-9]+)/) || [])[1] || '?';
        throw new Stop(200, 'other', `search answered with the site error page, code ${code}`, BASE + 'default.aspx');
      }
      throw new Stop(200, 'layout_changed', 'search answer has no result frame', BASE + 'default.aspx');
    }
    const listUrl = BASE + listMatch[0];

    // 3. the first page of results (20 judgments)
    const listHtml = await go(listUrl, { method: 'GET' }, 'result list');
    if (!listHtml.includes('id="jud"') && !listHtml.includes('hlTitle')) {
      if (/ErrorPage|查無資料/.test(listHtml)) {
        return { status: 'not_found', reason: '', records: [], source_url: listUrl, excerpt: '系統訊息：查無資料' };
      }
      throw new Stop(200, 'layout_changed', 'result list has no judgment table', listUrl);
    }

    const rows = parseRows(listHtml);
    const matched = [];
    for (const row of rows) {
      // the site highlights the words it matched (not always, e.g. for the 臺 spelling), so also check the text
      const hit = row.highlights.find((h) => sameCompany(h, kw)) || (containsName(row.snippet, kw) ? kw : '');
      if (!hit) continue;
      matched.push({
        name: hit,
        case_title: row.case_title,
        date: isoFromRoc(row.date_roc),
        date_roc: row.date_roc,
        cause: row.cause,
        judgment_url: row.judgment_url,
        excerpt: row.snippet.slice(0, 300),
      });
    }

    const summary = `${total} judgments contain the search words; page 1 shows ${rows.length}, ${matched.length} with this company name`;
    if (matched.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: listUrl, excerpt: summary + ' (no judgment shows the company name as written)' };
    }
    return {
      status: 'found',
      reason: '',
      records: matched.map(({ excerpt, ...r }) => r),
      source_url: listUrl,
      excerpt: summary + '. ' + matched[0].excerpt,
    };
  } catch (err) {
    if (err instanceof Stop) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url || BASE, excerpt: String(err.excerpt).slice(0, 300) };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
