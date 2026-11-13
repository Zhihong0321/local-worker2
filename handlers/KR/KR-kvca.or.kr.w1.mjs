export const meta = {
  task: 'KR-kvca.or.kr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ceo', 'phone', 'homepage', 'list_no'],
  canary: { found: '경남벤처투자', not_found: '존재하지않는테스트회사' },
};

// KVCA member directory (회원사안내): a plain HTML list with a company-name search (keyfield=mname).
const BASE = 'https://www.kvca.or.kr/Program/membership/list.html?a_gb=member&a_cd=2&a_item=0&sm=5_3_1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 20;          // result pages read per search
const START_NO_NEW_FETCH_MS = 30000; // no new fetch after 30 s, so the whole call stays under 60 s

// Legal-form words and marks; the site may or may not include them in the stored name.
const LEGAL_FORMS = [
  /주식회사/g, /유한책임회사/g, /유한회사/g, /합자회사/g, /합명회사/g,
  /\(주\)/g, /\(유\)/g, /\(사\)/g, /\(재\)/g,
  /\bco\.?\s*,?\s*ltd\.?/gi, /\bltd\.?/gi, /\blimited\b/gi, /\bcorporation\b/gi, /\bcorp\.?/gi, /\binc\.?/gi, /\bco\.?/gi,
];

function stripLegalForm(name) {
  let s = String(name || '').normalize('NFKC');
  for (const re of LEGAL_FORMS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Comparison key: legal form removed, lower case, only letters and digits.
function compareKey(name) {
  return stripLegalForm(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function searchUrl(key, page) {
  const u = new URL(BASE);
  u.searchParams.set('keyfield', 'mname');
  u.searchParams.set('key', key);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function parsePage(html) {
  const countMatch = html.match(/전체게시물수\s*:\s*([\d,]+)\s*건/);
  const emptyMarker = html.includes('검색된 회원정보가 없습니다');
  if (!countMatch && !emptyMarker) return null;
  const total = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : 0;
  const rows = [];
  const rowRe = /<tr>\s*<td class="td_bg\d[^"]*"[^>]*>\s*(\d+)\s*<\/td>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => cleanText(c[1]));
    rows.push({ list_no: m[1], name: cells[0] || '', ceo: cells[1] || '', phone: cells[2] || '', homepage: cells[3] || '' });
  }
  return { total, rows };
}

/** Fetch one result page and parse it. Returns { fail } with a couldnt_check answer, or { total, rows }. */
async function readPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: out('couldnt_check', timedOut ? 'timeout' : 'other', [], url, String(e?.message || e)) };
  }
  if (res.status === 403 || res.status === 429) {
    return { fail: out('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { fail: out('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`) };
  }
  const html = await res.text();
  const answered = html.includes('전체게시물수') || html.includes('검색된 회원정보가 없습니다');
  if (!answered && /captcha|보안문자|비정상적인\s*접근/i.test(html)) {
    return { fail: out('couldnt_check', 'blocked', [], url, 'bot check page') };
  }
  const parsed = parsePage(html);
  if (!parsed) {
    return { fail: out('couldnt_check', 'layout_changed', [], url, cleanText(html).slice(0, 300)) };
  }
  if (parsed.total > 0 && parsed.rows.length === 0) {
    return { fail: out('couldnt_check', 'layout_changed', [], url, `page says ${parsed.total} results but no rows parsed`) };
  }
  return parsed;
}

/** Look one company up in the KVCA member list. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows can abort on process.exit() while a keep-alive socket from fetch is still closing.
  // A short pause after the last request lets the socket close first.
  await new Promise((r) => setTimeout(r, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const t0 = Date.now();
  try {
    const core = stripLegalForm(keyword);
    if (!compareKey(core)) {
      return out('couldnt_check', 'other', [], BASE, 'no name left after removing the legal form');
    }

    let key = core;
    let url = searchUrl(key, 1);
    let first = await readPage(url);
    if (first.fail) return first.fail;

    // Some stored names have no spaces; retry once without spaces when the spaced search finds nothing.
    if (first.total === 0 && /\s/.test(key)) {
      key = key.replace(/\s+/g, '');
      url = searchUrl(key, 1);
      first = await readPage(url);
      if (first.fail) return first.fail;
    }

    const rows = [...first.rows];
    const pageSize = first.rows.length;
    const lastPage = Math.ceil(first.total / pageSize);
    if (lastPage > MAX_PAGES) {
      return out('couldnt_check', 'other', [], url, `${first.total} results for "${key}", more than ${MAX_PAGES} pages; not checked`);
    }
    for (let p = 2; p <= lastPage; p++) {
      if (Date.now() - t0 > START_NO_NEW_FETCH_MS) {
        return out('couldnt_check', 'timeout', [], url, `${first.total} results; stopped after page ${p - 1} to stay under 60 s`);
      }
      const next = await readPage(searchUrl(key, p));
      if (next.fail) return next.fail;
      rows.push(...next.rows);
    }

    const want = compareKey(core);
    const matches = rows.filter((r) => compareKey(r.name) === want);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({ name: r.name, ceo: r.ceo, phone: r.phone, homepage: r.homepage, list_no: r.list_no })),
        source_url: url,
        excerpt: `KVCA member list: ${matches.length} exact name match(es) out of ${first.total} result(s) for "${key}"`,
      };
    }
    const near = rows.slice(0, 5).map((r) => r.name).join(', ');
    return out(
      'not_found', '', [], url,
      first.total === 0
        ? `KVCA member list: 0 results for "${key}"`
        : `KVCA member list: ${first.total} result(s) for "${key}", none with this name. Similar: ${near}`,
    );
  } catch (err) {
    return out('couldnt_check', 'other', [], searchUrl(stripLegalForm(keyword), 1), String(err?.message || err));
  }
}
