export const meta = {
  task: 'TW-ftc.gov.tw',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'decision_date', 'decision_type', 'law_articles', 'case_title', 'pdf_url'],
  canary: { found: '鑫田發股份有限公司', not_found: '不存在測試股份有限公司' },
};

const LIST_URL = 'https://www.ftc.gov.tw/internet/main/decision/decisionList.aspx?mid=11';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_BOX = 'ctl00$ContentPlaceHolder1$PdfKeyWords';
const SEARCH_BTN = 'ctl00$ContentPlaceHolder1$searchButton';
const NEXT_BTN = 'ctl00$ContentPlaceHolder1$btn_nextPageButton';
const MAX_PAGES = 10;      // at most 100 decisions read for one company
const BUDGET_MS = 30000;   // no new page after 30 s; one page is at most 25 s, so the call stays under 60 s

// A party name in a decision title: a run of text ending in a company suffix, starting at the title
// start or after a separator (、，, 與 及 和 ; ；). The name stops before the predicate words (於, 從事 ...).
const PARTY_RE = /(?:^|[、，,與及和;；])\s*([^、，,與及和;；於從在就涉為依由因對經\n]{1,80}?(?:股份有限公司|有限公司|公司|Limited|LIMITED|Ltd\.?|Inc\.?|Corporation|Co\.,?\s*Ltd\.?))/g;

function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.,()\-_'"「」『』]/g, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, '; ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/(;\s*)+$/, '')
    .trim();
}

function partiesOf(title) {
  const out = [];
  for (const m of String(title).matchAll(PARTY_RE)) out.push(m[1].trim());
  return out;
}

function ua() {
  return { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.6' };
}

// Cookie jar kept as a map: name -> value. Handles both getSetCookie() and the single joined header.
function absorbCookies(jar, res) {
  let raw = [];
  if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
  else raw = [res.headers.get('set-cookie') || ''];
  for (const line of raw) {
    for (const part of line.split(/,(?=\s*[^;,=\s]+=)/)) {
      const kv = part.split(';')[0].trim();
      const eq = kv.indexOf('=');
      if (eq > 0) jar.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function hidden(html, id) {
  const m = html.match(new RegExp(`id="${id}" value="([^"]*)"`));
  return m ? m[1] : null;
}

function readState(html) {
  return {
    viewstate: hidden(html, '__VIEWSTATE'),
    generator: hidden(html, '__VIEWSTATEGENERATOR'),
    eventvalidation: hidden(html, '__EVENTVALIDATION'),
  };
}

function looksBlocked(html) {
  return /captcha|verification code|驗證碼|access denied/i.test(html.slice(0, 20000));
}

/** Parse one results page. Returns null when the page is not the expected layout. */
function parseResults(html) {
  const totalM = html.match(/id="ContentPlaceHolder1_lb_totalRows"[^>]*>\s*(\d+)\s*</);
  const pageM = html.match(/id="ContentPlaceHolder1_lb_currentPage"[^>]*>\s*(\d+)\s*\/\s*(\d+)\s*</);
  if (!totalM || !pageM) return null;
  const rows = [];
  for (const block of html.split('<ul class="result-list">').slice(1)) {
    const link = block.match(/<a href=['"]([^'"]+)['"][^>]*title=['"]([^'"]*)['"]/);
    if (!link) continue;
    const date = block.match(/發文日期<\/span>\s*<p>([\s\S]*?)<\/p>/);
    const type = block.match(/類型<\/span>\s*<p>([\s\S]*?)<\/p>/);
    const law = block.match(/相關法條<\/span>\s*<p>([\s\S]*?)<\/p>/);
    rows.push({
      decision_date: date ? cleanText(date[1]) : '',
      decision_type: type ? cleanText(type[1]) : '',
      law_articles: law ? cleanText(law[1]) : '',
      case_title: decode(link[2]).replace(/\s+/g, ' ').trim(),
      pdf_url: decode(link[1]),
    });
  }
  return {
    total: Number(totalM[1]),
    cur: Number(pageM[1]),
    pages: Number(pageM[2]),
    rows,
  };
}

function result(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  if (!kw) return result('couldnt_check', 'other', [], LIST_URL, 'empty company name');
  const normKw = norm(kw);
  const jar = new Map();
  let html = '';
  let state = null;
  let lastStage = 'start';

  // POST the search form (or a pager button) using the state of the page we last received.
  async function postPage(target) {
    const body = new URLSearchParams({
      __EVENTTARGET: target,
      __EVENTARGUMENT: '',
      __VIEWSTATE: state.viewstate,
      __VIEWSTATEGENERATOR: state.generator,
      [SEARCH_BOX]: kw,
      'ctl00$ContentPlaceHolder1$FormalDocDateStart': '',
      'ctl00$ContentPlaceHolder1$FormalDocDateEnd': '',
    });
    if (state.eventvalidation !== null) body.set('__EVENTVALIDATION', state.eventvalidation);
    const res = await fetch(LIST_URL, {
      method: 'POST',
      headers: {
        ...ua(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': LIST_URL,
        'Origin': 'https://www.ftc.gov.tw',
        ...(jar.size ? { Cookie: cookieHeader(jar) } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    absorbCookies(jar, res);
    if (res.status === 403 || res.status === 429) return { blocked: true, status: res.status };
    if (!res.ok) return { httpError: true, status: res.status };
    const text = await res.text();
    if (looksBlocked(text)) return { blocked: true, status: res.status };
    html = text;
    state = readState(text);
    return { ok: true };
  }

  try {
    // Stage 1: open the decisions list to get the form token and session cookie.
    lastStage = 'open list page';
    const page = await fetch(LIST_URL, { headers: ua(), signal: AbortSignal.timeout(25000) });
    absorbCookies(jar, page);
    if (page.status === 403 || page.status === 429) {
      return result('couldnt_check', 'blocked', [], LIST_URL, `HTTP ${page.status} on the decisions list page`);
    }
    if (!page.ok) return result('couldnt_check', 'http_error', [], LIST_URL, `HTTP ${page.status} on the decisions list page`);
    html = await page.text();
    if (looksBlocked(html)) return result('couldnt_check', 'blocked', [], LIST_URL, 'captcha or bot check on the decisions list page');
    state = readState(html);
    if (!html.includes(`id="ContentPlaceHolder1_PdfKeyWords"`) || !state.viewstate || !state.generator) {
      return result('couldnt_check', 'layout_changed', [], LIST_URL, html.slice(0, 300));
    }

    // Stage 2: run the search.
    lastStage = 'search';
    let r = await postPage(SEARCH_BTN);
    if (r.blocked) return result('couldnt_check', 'blocked', [], LIST_URL, `HTTP ${r.status} on search`);
    if (r.httpError) return result('couldnt_check', 'http_error', [], LIST_URL, `HTTP ${r.status} on search`);
    let parsed = parseResults(html);
    if (!parsed) return result('couldnt_check', 'layout_changed', [], LIST_URL, html.slice(0, 300));
    if (parsed.total === 0) {
      return result('not_found', '', [], LIST_URL, `Search for "${kw}": 0 decisions (共0筆)`);
    }
    if (parsed.rows.length === 0) {
      return result('couldnt_check', 'layout_changed', [], LIST_URL, `${parsed.total} hits but no result rows parsed`);
    }

    // Stage 3: read the remaining result pages (pager "next" button), within the budget.
    const rows = [...parsed.rows];
    let cur = parsed.cur;
    const lastPage = parsed.pages;
    let complete = cur >= lastPage;
    let pagesRead = 1;
    while (!complete && pagesRead < MAX_PAGES && Date.now() - started < BUDGET_MS) {
      lastStage = `page ${cur + 1}`;
      r = await postPage(NEXT_BTN);
      if (r.blocked || r.httpError) break;
      parsed = parseResults(html);
      if (!parsed || parsed.rows.length === 0 || parsed.cur <= cur) break;
      rows.push(...parsed.rows);
      cur = parsed.cur;
      pagesRead += 1;
      complete = cur >= parsed.pages;
    }

    // Stage 4: match the company by its normalised name against the parties named in each case title.
    const records = [];
    for (const row of rows) {
      const hit = partiesOf(row.case_title).find((p) => norm(p) === normKw);
      if (hit) records.push({ name: hit, ...row });
    }
    const scanNote = complete
      ? `all ${lastPage} result pages read`
      : `read ${pagesRead} of ${lastPage} result pages (partial)`;
    if (records.length > 0) {
      return result('found', '', records, LIST_URL,
        `${parsed.total} decisions match the search; ${records.length} name "${kw}" as a party. ${scanNote}. First: ${records[0].decision_date} ${records[0].case_title}`);
    }
    // The search matched decisions, but none names the company as a party in its title. The name may appear
    // only in the decision text, so this is not proof of absence.
    return result('couldnt_check', 'other', [], LIST_URL,
      `${parsed.total} decisions match "${kw}" but none names it as a party in the title. ${scanNote}. Titles: ${rows.slice(0, 3).map((x) => x.case_title).join(' | ')}`);
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return result('couldnt_check', reason, [], LIST_URL, `${lastStage}: ${String(err?.message || err)}`);
  }
}
