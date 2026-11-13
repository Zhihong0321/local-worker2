export const meta = {
  task: 'NZ-gazette.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['notice_number', 'title', 'notice_type', 'publication_date', 'notice_url', 'matched_text'],
  canary: { found: 'Kiri Investments Limited', not_found: 'Pūkeko Tātaki Kāhore Limited' },
};

// The Gazette search is a plain GET: /home/search?keyword="<exact phrase>" (quotes = phrase match, accents folded).
// One hit redirects straight to the notice page; several hits give a result list (100 rows a page, from=0,100,...).
// Each row's snippet is checked first, then the candidate notice pages are opened and the full name is checked there.

const BASE = 'https://gazette.govt.nz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;        // rows per search page
const MAX_PAGES = 3;     // at most 300 search rows are read
const MAX_CHECK = 10;    // notice pages opened to verify the name
const BUDGET_MS = 45000; // stop well before the 60 s limit
const TAIL = ['limited', 'partnership', 'incorporated', 'company', 'co'];
// words that may follow a name without changing which company it is (only for names typed without a legal form)
const NEXT_OK = new Set(['limited', 'partnership', 'incorporated', 'company', 'co', 'in', 'trading', 'as', 'formerly',
  'previously', 'the', 'of', 'no', 'number', 'registration', 'reg', 'nz']);

/** Normalised word list: accents folded, lower case, punctuation dropped, ltd/lp/inc/co spelled out. */
function tokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .flatMap((t) => (t === 'ltd' ? ['limited'] : t === 'lp' ? ['limited', 'partnership'] : t === 'inc' ? ['incorporated'] : t === 'co' ? ['company'] : [t]));
}

/** The company name without its trailing legal form, used as the search phrase (at least one word is kept). */
function searchPhrase(name) {
  const t = tokens(name);
  let end = t.length;
  if (end >= 2 && t[end - 1] === 'partnership' && t[end - 2] === 'limited') end -= 2;
  else while (end > 1 && TAIL.includes(t[end - 1])) end -= 1;
  return t.slice(0, end).join(' ');
}

/**
 * Does `text` name this company? Whole-word, in order. A name typed with a legal form must match that form
 * ("KIRI LIMITED" does not match "KIRI LIMITED PARTNERSHIP"). A name typed without one matches "KIRI" followed by
 * a legal form or an ordinary continuation such as "(in liquidation)", but not "KIRI INVESTMENTS".
 * `loose` = the name has no legal form to check (used for the cheap row prefilter).
 * Returns a short normalised excerpt around the match, or null.
 */
function findName(name, text, loose = false) {
  const want = tokens(name);
  const have = tokens(text);
  if (!want.length) return null;
  const last = want[want.length - 1];
  const hasTail = !loose && TAIL.includes(last);
  for (let i = 0; i + want.length <= have.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (have[i + j] !== want[j]) { ok = false; break; }
    }
    if (!ok) continue;
    const next = have[i + want.length];
    const bad = hasTail
      ? next === 'partnership' && last !== 'partnership'
      : next !== undefined && !NEXT_OK.has(next) && !/^\d+$/.test(next);
    if (bad) continue;
    return have.slice(Math.max(0, i - 6), i + want.length + 6).join(' ');
  }
  return null;
}

function visibleText(html) {
  return String(html || '')
    .replace(/<!--|-->/g, ' ') // result snippets are kept inside HTML comments on the search page
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function searchUrl(phrase, from) {
  const u = new URL('/home/search', BASE);
  u.searchParams.set('keyword', `"${phrase}"`);
  if (from) u.searchParams.set('from', String(from));
  return u.href;
}

// The site's bot wall answers HTTP 200 with a short "Request unsuccessful. Incapsula incident ID" page.
const BOT_WALL = /Incapsula incident|_Incapsula_Resource|Request unsuccessful\. Incapsula/i;

/**
 * One GET. Throws (with a `code`) on a bot wall, 403/429, or any other HTTP error, so a refused request can never
 * come back as a normal page. Network failure and timeouts also throw; lookup() maps every throw to couldnt_check.
 */
async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.text();
  if (res.status === 403 || res.status === 429 || BOT_WALL.test(body)) {
    throw Object.assign(new Error(`HTTP ${res.status}, bot wall or refusal`), { code: 'blocked' });
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http_error' });
  return { url: res.url, body };
}

function totalHits(text) {
  const m = text.match(/([\d,]+)\s+notices?\s+found/i);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  if (/There are no matching results/i.test(text)) return 0;
  return null;
}

/** Result rows of one search page. Each row: notice id, title, date and the snippet text. */
function parseRows(html) {
  return html.split(/<tr\s+class="group\b/).slice(1).map((chunk) => {
    const row = chunk.split('</tr>')[0];
    const idm = row.match(/href="\/notice\/id\/([^"]+)"/);
    if (!idm) return null;
    const titleM = row.match(/mb-2 mt-6[^>]*>([\s\S]*?)<\/span>/);
    const dateM = row.match(/text-4xl\/9">\s*(\d{1,2})\s*<\/span>\s*<span[^>]*>\s*([A-Za-z]{3})\s*<\/span>\s*<span[^>]*>\s*(\d{4})/);
    return {
      id: idm[1],
      title: titleM ? visibleText(titleM[1]) : '',
      date: dateM ? `${dateM[1]} ${dateM[2]} ${dateM[3]}` : '',
      text: visibleText(row),
    };
  }).filter(Boolean);
}

/** A notice page: its own fields and its body text (from "Notice Title" on). Null if the page is not a notice. */
function parseNotice(html, url) {
  const text = visibleText(html);
  const start = text.indexOf('Notice Title');
  if (start < 0) return null;
  const body = text.slice(start);
  const title = (body.match(/Notice Title (.+?) Notice Type /) || [])[1] || '';
  const noticeType = (body.match(/Notice Type (.+?) Publication Date/) || [])[1] || '';
  const date = (body.match(/Publication Date (\d{1,2} [A-Za-z]{3} \d{4})/) || [])[1] || '';
  const number = (body.match(/Notice Number (\d{4}-[a-z]{2}\d+)/) || [])[1] || (url.match(/\/notice\/id\/([^/?#]+)/) || [])[1] || '';
  return { body, title, noticeType, date, number, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await lookupOnce(keyword);
  // On Windows, Node can abort on process.exit() while a large response's socket is still closing; a short pause avoids it.
  await new Promise((r) => setTimeout(r, 300));
  return out;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  if (!tokens(name).length) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
  }
  const phrase = searchPhrase(name);
  const firstUrl = searchUrl(phrase, 0);
  try {
    const first = await get(firstUrl);

    // One hit: the site sends the search straight to the notice.
    if (/\/notice\/id\//.test(first.url)) {
      const n = parseNotice(first.body, first.url);
      if (!n) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: first.url, excerpt: first.body.slice(0, 300) };
      const m = findName(name, n.body);
      if (!m) {
        return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
          excerpt: `Search "${phrase}" has one notice (${n.number}, "${n.title}"), and it does not name this company` };
      }
      return { status: 'found', reason: '', source_url: n.url, excerpt: m, records: [{
        notice_number: n.number, title: n.title, notice_type: n.noticeType, publication_date: n.date, notice_url: n.url, matched_text: m,
      }] };
    }

    const text = visibleText(first.body);
    const total = totalHits(text);
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl, excerpt: `There are no matching results for "${phrase}"` };
    }
    if (total === null) {
      if (/captcha|access denied|unusual traffic|are you a robot/i.test(text)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: firstUrl, excerpt: text.slice(0, 200) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl, excerpt: text.slice(0, 300) };
    }

    const verified = [];
    const seen = new Set();
    let checked = 0;
    let rowsRead = 0;
    let html = first.body;
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      if (page > 0) {
        if (from >= total || Date.now() - started > BUDGET_MS) break;
        html = (await get(searchUrl(phrase, from))).body;
      }
      const rows = parseRows(html);
      rowsRead += rows.length;
      for (const row of rows) {
        if (seen.has(row.id) || checked >= MAX_CHECK || Date.now() - started > BUDGET_MS) continue;
        // cheap prefilter on the row (title + snippet), then the full name on the notice page
        if (!findName(phrase, `${row.title} ${row.text}`, true)) continue;
        seen.add(row.id);
        checked += 1;
        const noticeUrl = `${BASE}/notice/id/${row.id}`;
        const nr = await get(noticeUrl);
        const n = parseNotice(nr.body, noticeUrl);
        const m = n ? findName(name, n.body) : null;
        if (m) {
          verified.push({
            notice_number: n.number, title: n.title, notice_type: n.noticeType, publication_date: n.date || row.date,
            notice_url: noticeUrl, matched_text: m,
          });
        }
      }
      if (rows.length < PAGE) break;
    }

    if (verified.length) {
      const records = verified.slice(0, 20);
      return { status: 'found', reason: '', records, source_url: firstUrl, excerpt: records[0].matched_text };
    }
    const complete = rowsRead >= total;
    if (complete) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `Search "${phrase}" returned ${total} notices; none names this company` };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
      excerpt: `Search "${phrase}" returned ${total} notices; only the first ${rowsRead} were read and none named this company` };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const reason = err?.code === 'blocked' ? 'blocked' : err?.code === 'http_error' ? 'http_error' : timedOut ? 'timeout' : 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
