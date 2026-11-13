export const meta = {
  task: 'JP-no-trouble.caa.go.jp',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'action', 'transaction_type', 'goods_services', 'violation', 'law_articles', 'disposal_date', 'authority', 'notice_url'],
  canary: { found: '株式会社Jstyle', not_found: '架空テスト商事株式会社' },
};

const BASE = 'https://www.no-trouble.caa.go.jp';
const SEARCH_PAGE = `${BASE}/search/`;
const RESULT_PAGE = `${BASE}/search/result.html`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HIT_MARK = 'p-search-jigyousya';
const NONE_MARK = '見当たりません';
// No new request starts after 30 s; one request can take at most 25 s, so the call ends well under 60 s.
const START_BUDGET_MS = 30000;
const MAX_PAGES = 30;

class Stop extends Error {
  constructor(reason, excerpt) {
    super(excerpt || reason);
    this.reason = reason;
    this.excerpt = excerpt || reason;
  }
}

function safeCodePoint(n) {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Legal forms, removed after NFKC + lowercase, so "株式会社ＨＯＰＥ Ｇｒｏｕｐ" and "株式会社HOPE Group" compare equal.
const LEGAL_RE = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|\(株\)|\(有\)|\(同\)|co\.?\s*,?\s*ltd\.?|\bltd\.?|\binc\.?|\bcorp(?:oration)?\.?|\bllc\.?|\blimited\b|\bcompany\b|\bco\.?(?=\W|$)|sdn\.?\s*bhd\.?|pte\.?\s*ltd\.?/g;

function nameKey(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(LEGAL_RE, '').replace(/[^\p{L}\p{N}]/gu, '');
}

// The site lists "エザキ塗装こと江﨑保之": the part after "こと" is the individual's own name, so it counts too.
function rowMatches(rowName, key) {
  if (!key) return false;
  return rowName.split(/こと/).concat([rowName]).some((part) => nameKey(part) === key);
}

function coreName(keyword) {
  return keyword
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|\(株\)|\(有\)|㈱|㈲/g, ' ')
    .replace(/co\.?\s*,?\s*ltd\.?|\b(?:ltd|inc|corp|corporation|llc|limited|company|co|sdn\s*bhd|pte\s*ltd)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.]+|[\s,.]+$/g, '')
    .trim();
}

// The site stores Latin letters and digits in full-width form, and its search is a plain substring match.
function fullWidth(s) {
  return s.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

function queriesFor(keyword) {
  const core = coreName(keyword);
  const list = [keyword, core, fullWidth(core), fullWidth(keyword)].map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)];
}

function absorbCookies(res, jar) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') {
    list = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = raw.split(/,(?=\s*[^;,=\s]+=)/);
  }
  for (const c of list) {
    const pair = c.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function call(url, jar, init = {}) {
  const headers = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'ja,en;q=0.8',
    ...(init.headers || {}),
  };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(25000) });
  absorbCookies(res, jar);
  const text = await res.text();
  if (res.status === 403 || res.status === 429) throw new Stop('blocked', `HTTP ${res.status} at ${url}`);
  if (res.status < 200 || res.status >= 300) throw new Stop('http_error', `HTTP ${res.status} at ${url}`);
  return text;
}

function checkBudget(t0) {
  if (Date.now() - t0 > START_BUDGET_MS) throw new Stop('timeout', 'the search did not finish within the time budget');
}

function checkResultPage(text) {
  if (text.includes(HIT_MARK) || text.includes(NONE_MARK)) return;
  if (/captcha|アクセスが制限/i.test(text)) throw new Stop('blocked', 'the site returned a bot or access check instead of results');
  throw new Stop('layout_changed', 'the result page does not have the expected results table or the no-match message');
}

function parseRows(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = m[1];
    if (!row.includes(HIT_MARK)) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length !== 8) throw new Stop('layout_changed', `a result row has ${cells.length} cells, expected 8`);
    const href = (cells[0].match(/href="([^"]+)"/) || [])[1] || '';
    let notice_url = '';
    try {
      notice_url = href ? new URL(decodeEntities(href), BASE).href : '';
    } catch {
      notice_url = '';
    }
    out.push({
      name: cleanText(cells[0]),
      action: cleanText(cells[1]),
      transaction_type: cleanText(cells[2]),
      goods_services: cleanText(cells[3]),
      violation: cleanText(cells[4]),
      law_articles: cleanText(cells[5]),
      disposal_date: cleanText(cells[6]),
      authority: cleanText(cells[7]),
      notice_url,
    });
  }
  return out;
}

// The pager forms name each page in their action: result.html is page 1, result2.html page 2, ...
function pageCount(html) {
  let max = 1;
  for (const m of html.matchAll(/<form action="([^"]*)" method="post" id="pager_[a-z0-9_]+"/g)) {
    const p = m[1].match(/result(\d*)\.html/);
    if (p) max = Math.max(max, p[1] ? Number(p[1]) : 1);
  }
  return max;
}

function searchBody(token, person) {
  return new URLSearchParams({
    token,
    search: '1',
    person,
    atext: '',
    type: '',
    item: '',
    action: '',
    disposal_admin: '',
    provision: '',
    disposal_start_y: '',
    disposal_start_m: '',
    disposal_start_d: '',
    disposal_end_y: '',
    disposal_end_m: '',
    disposal_end_d: '',
  }).toString();
}

const POST_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

function answer(status, reason, records, excerpt) {
  return { status, reason, records, source_url: RESULT_PAGE, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const kw = String(keyword ?? '').trim();
  const tried = [];
  try {
    const key = nameKey(kw);
    if (!kw || !key) {
      return answer('couldnt_check', 'other', [], 'empty keyword, or no name left after removing the legal form');
    }

    const jar = new Map();
    checkBudget(t0);
    const searchHtml = await call(SEARCH_PAGE, jar);
    const token = (searchHtml.match(/name="token" value="([^"]+)"/) || [])[1];
    if (!token) throw new Stop('layout_changed', 'the search page has no token field');

    for (const q of queriesFor(kw)) {
      tried.push(q);
      checkBudget(t0);
      const html = await call(RESULT_PAGE, jar, { method: 'POST', headers: POST_HEADERS, body: searchBody(token, q) });
      checkResultPage(html);
      const rows = parseRows(html);

      let partial = false;
      const last = pageCount(html);
      if (last > MAX_PAGES) partial = true;
      for (let p = 2; p <= Math.min(last, MAX_PAGES); p++) {
        if (Date.now() - t0 > START_BUDGET_MS) {
          partial = true;
          break;
        }
        const pageHtml = await call(`${BASE}/search/result${p}.html`, jar, { method: 'POST', headers: POST_HEADERS, body: searchBody(token, q) });
        checkResultPage(pageHtml);
        rows.push(...parseRows(pageHtml));
      }

      const seen = new Set();
      const matched = rows.filter((r) => {
        if (!rowMatches(r.name, key)) return false;
        const id = JSON.stringify(r);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      if (matched.length) {
        const names = [...new Set(matched.map((r) => r.name))].join(', ');
        const first = matched[0];
        const note = partial ? ' (partial: not every result page was read)' : '';
        return answer('found', '', matched,
          `${matched.length} action(s) for ${names} via search "${q}"${note}. First: ${first.name} | ${first.action} | ${first.transaction_type} | ${first.disposal_date} | ${first.authority}`);
      }
      // Not matched on this query, but unread pages could still hold the company: do not call it not_found.
      if (partial) throw new Stop('timeout', `search "${q}" matched more pages than were read within the time budget`);
    }

    return answer('not_found', '', [],
      `The site answered normally for ${tried.length} search(es): ${tried.map((q) => `"${q}"`).join(', ')}. No listed name matches "${kw}".`);
  } catch (err) {
    if (err instanceof Stop) return answer('couldnt_check', err.reason, [], err.excerpt);
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return answer('couldnt_check', reason, [], String((err && err.message) || err).slice(0, 300));
  }
}
