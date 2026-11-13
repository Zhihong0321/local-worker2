export const meta = {
  task: 'VN-otofun.net',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['title', 'url', 'forum', 'date', 'replies', 'author', 'match_in', 'snippet'],
  canary: { found: 'VinFast', not_found: 'Công ty TNHH Xyzqwop Bảo Lộc Hòa Bình' },
};

const BASE = 'https://www.otofun.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 5;
// A new page is only started before 30 s, so one more 25 s fetch still ends well inside the 60 s limit.
const PAGE_BUDGET_MS = 30000;

// Legal-form words (normalised), removed only at the start or end of the typed name.
const LEGAL_SEQUENCES = [
  ['cong', 'ty', 'trach', 'nhiem', 'huu', 'han'], ['cong', 'ty', 'co', 'phan'], ['cong', 'ty', 'tnhh', 'mot', 'thanh', 'vien'],
  ['cong', 'ty', 'tnhh'], ['cong', 'ty'], ['tnhh', 'mot', 'thanh', 'vien'], ['tnhh', 'mtv'], ['tnhh'], ['mtv'],
  ['doanh', 'nghiep', 'tu', 'nhan'], ['dntn'], ['ctcp'], ['cp'], ['cty'], ['jsc'], ['joint', 'stock', 'company'],
  ['sdn', 'bhd'], ['pte', 'ltd'], ['co', 'ltd'], ['corp'], ['corporation'], ['company'], ['llc'], ['plc'], ['inc'],
  ['limited'], ['ltd'], ['co'],
];

/** Lower-case, no diacritics, letters and digits only, single spaces. */
function normWord(s) {
  return decodeEntities(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Decode the entities XenForo writes in titles and snippets. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([A-Za-z])(acute|grave|tilde|circ|uml|cedil|ring|caron|slash);/g, '$1')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/&#039;|&apos;/gi, "'");
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ' '; }
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Split a typed company name into the words used for searching and matching, without the legal form. */
function coreWords(keyword) {
  const tokens = String(keyword || '').trim().split(/\s+/).filter(Boolean)
    .map((t) => ({ raw: t, norm: normWord(t) }))
    .filter((t) => t.norm !== '');
  let items = tokens;
  let changed = true;
  while (changed && items.length) {
    changed = false;
    for (const seq of LEGAL_SEQUENCES) {
      const words = items.map((t) => t.norm);
      if (words.length > seq.length && seq.every((w, i) => words[i] === w)) {
        items = items.slice(seq.length); changed = true; break;
      }
      if (words.length > seq.length && seq.every((w, i) => words[words.length - seq.length + i] === w)) {
        items = items.slice(0, items.length - seq.length); changed = true; break;
      }
    }
  }
  return items;
}

/** Phrase test on normalised text: the company words appear as whole words, in order. */
function containsPhrase(text, phrase) {
  return ` ${text} `.includes(` ${phrase} `);
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function getPage(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'vi,en;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
}

function parseRows(html) {
  const rows = [];
  for (const chunk of html.split('<li class="block-row').slice(1)) {
    const link = chunk.match(/<h3 class="contentRow-title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const snippetHtml = (chunk.match(/<div class="contentRow-snippet">([\s\S]*?)<\/div>/) || [])[1] || '';
    const forum = (chunk.match(/Diễn đàn:\s*<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '';
    const date = (chunk.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || '';
    const replies = (chunk.match(/Trả lời:\s*(\d+)/) || [])[1] || '';
    const author = (chunk.match(/data-author="([^"]*)"/) || [])[1] || '';
    rows.push({
      url: new URL(decodeEntities(link[1]), BASE).href,
      title: cleanText(link[2]),
      snippet: cleanText(snippetHtml).slice(0, 300),
      forum: cleanText(forum),
      date,
      replies,
      author: cleanText(author),
    });
  }
  return rows;
}

/** Look one company up in the forum search. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const words = coreWords(keyword);
    if (!words.length) {
      return fail('couldnt_check', 'other', BASE, 'no company words left after removing the legal form');
    }
    const query = words.map((w) => w.raw).join(' ');
    const phrase = words.map((w) => w.norm).join(' ');
    searchUrl = `${BASE}/search/search?keywords=${encodeURIComponent(query)}&order=relevance`;

    const started = Date.now();
    const matches = [];
    let hits = 0;
    let nextUrl = searchUrl;
    let pagesChecked = 0;

    while (nextUrl && pagesChecked < MAX_PAGES) {
      const res = await getPage(nextUrl);
      if (res.status === 403 || res.status === 429) {
        return fail('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return fail('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);
      }
      const html = await res.text();

      if (/captcha|cf-chl|Just a moment|cf_chl_opt/i.test(html)) {
        return fail('couldnt_check', 'blocked', searchUrl, 'bot or captcha check page');
      }
      if (/\/login\b/i.test(res.url) || /<div class="blockMessage[^"]*">\s*(You must be logged|Bạn cần đăng nhập)/i.test(html)) {
        return fail('couldnt_check', 'blocked', searchUrl, 'login wall: ' + res.url);
      }
      if (/Bạn đang tìm kiếm quá nhanh|search too often|too many requests|quá nhiều yêu cầu/i.test(html)) {
        return fail('couldnt_check', 'blocked', searchUrl, 'search rate limit message');
      }

      pagesChecked++;
      const rows = parseRows(html);
      const isEmptyResult = /<div class="blockMessage">\s*(Không tìm thấy|No results? found)/i.test(html);
      const isSearchPage = /data-template="search_results"/.test(html);

      if (!rows.length && !isEmptyResult) {
        return fail('couldnt_check', 'layout_changed', searchUrl, html.slice(0, 300));
      }
      if (!isSearchPage && !isEmptyResult) {
        return fail('couldnt_check', 'layout_changed', searchUrl, 'unexpected page template');
      }

      hits += rows.length;
      for (const row of rows) {
        const inTitle = containsPhrase(normWord(row.title), phrase);
        const inSnippet = !inTitle && containsPhrase(normWord(row.snippet), phrase);
        if (inTitle || inSnippet) {
          matches.push({ title: row.title, url: row.url, forum: row.forum, date: row.date,
            replies: row.replies, author: row.author, match_in: inTitle ? 'title' : 'snippet', snippet: row.snippet });
        }
      }

      const next = html.match(/<link rel="next" href="([^"]+)"/) || html.match(/<a href="([^"]+)"[^>]*pageNav-jump--next/);
      nextUrl = next ? new URL(decodeEntities(next[1]), BASE).href : '';
      if (nextUrl && Date.now() - started > PAGE_BUDGET_MS) break;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.slice(0, 50),
        source_url: searchUrl,
        excerpt: `${matches.length} forum item(s) name "${query}" (checked ${hits} search results on ${pagesChecked} page(s))`,
      };
    }

    if (nextUrl) {
      return fail('couldnt_check', 'other', searchUrl,
        `no match on the first ${pagesChecked} page(s) of ${hits}+ search results; cannot prove absence`);
    }

    if (!hits) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `search "${query}" returned no results` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `${hits} search result(s) for "${query}", none names the company` };
  } catch (err) {
    const name = err && err.name ? err.name : '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail('couldnt_check', reason, searchUrl || BASE, String(err && err.message ? err.message : err));
  }
}
