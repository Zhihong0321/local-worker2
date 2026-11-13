export const meta = { task: 'JP-5ch.net', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['thread_title', 'board', 'last_post_date', 'post_count', 'posts_per_day', 'thread_url'],
  canary: { found: '日本郵便株式会社', not_found: 'ゼッタイニナイカイシャ株式会社' } };

// 5ch.net now redirects to 5ch.io. The thread-title search lives at find.5ch.io/search?q=...
// It lists threads whose title contains the query. It does NOT say "0 results" for an unknown name when the
// query still carries a legal form (株式会社 etc.): it returns 100 popular threads that merely share that suffix.
// So the legal form is removed first, and each returned title is checked for the company name itself.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://find.5ch.io/search?q=';

const LEGAL_JA = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|\(株\)|\(有\)|\(合\)/g;
const LEGAL_EN = /(?<![a-z])(co\.?\s*,?\s*ltd\.?|corporation|incorporated|inc\.?|limited|ltd\.?|llc|k\.?\s?k\.?|kabushiki\s+kaisha|corp\.?|gk|g\.k\.)(?![a-z])/gi;

/** The company name without its legal form, e.g. "株式会社トヨタ自動車" -> "トヨタ自動車". */
function coreName(keyword) {
  return String(keyword || '').normalize('NFKC').replace(LEGAL_JA, ' ').replace(LEGAL_EN, ' ')
    .replace(/[,.]+\s*$/, '').replace(/\s+/g, ' ').trim();
}

/** Letters and digits only, lower case: used to compare a name with a title. */
function squash(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Same as squash but keeps word breaks as single spaces. */
function wordify(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}

/** Does this thread title contain the company name? ASCII names must match whole words. */
function nameInTitle(title, core) {
  const sq = squash(core);
  if (!sq) return false;
  if (/^[a-z0-9]+$/.test(sq)) {
    const words = wordify(core).split(' ').filter(Boolean)
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    return new RegExp('(?<![a-z0-9])' + words + '(?![a-z0-9])').test(wordify(title));
  }
  return squash(title).includes(sq);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function clean(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** One object per thread row on the result page. */
function parseResults(html) {
  const out = [];
  for (const chunk of html.split('<div class="list_line">').slice(1)) {
    const href = (chunk.match(/class="list_line_link" href="([^"]+)"/) || [])[1];
    const rawTitle = (chunk.match(/class="list_line_link_title">([\s\S]*?)<\/div>/) || [])[1];
    if (!href || rawTitle === undefined) continue;
    let title = clean(rawTitle);
    let posts = null;
    const pm = title.match(/\s*\((\d+)\)\s*$/);
    if (pm) { posts = Number(pm[1]); title = title.slice(0, pm.index).trim(); }
    const board = clean((chunk.match(/list_line_info_container-board"><a [^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    const date = clean((chunk.match(/<div class="list_line_info_container">([^<]*)<\/div>/) || [])[1]);
    const rate = clean((chunk.match(/list_line_info_container-danger">([^<]*)<\/div>/) || [])[1]);
    const url = href.startsWith('//') ? 'https:' + href : new URL(href, SEARCH).href;
    out.push({ thread_title: title, board, last_post_date: date, post_count: posts, posts_per_day: rate, thread_url: url });
  }
  return out;
}

const couldnt = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = '';
  try {
    const core = coreName(keyword);
    if (!core) return couldnt('other', '', 'no company name is left once the legal form is removed');
    url = SEARCH + encodeURIComponent(core);

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

    const html = await res.text();
    if (!html.includes('class="list"')) {
      if (/captcha|cf-chl|Just a moment|Attention Required|Access denied/i.test(html)) {
        return couldnt('blocked', url, 'bot check or captcha page');
      }
      return couldnt('layout_changed', url, html.slice(0, 300));
    }

    const items = parseResults(html);
    if (items.length === 0) {
      if (html.includes('No results found.')) {
        return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `Site: "No results found." for ${core}` };
      }
      return couldnt('layout_changed', url, 'result list has no rows and no "No results found." text');
    }

    const matches = items.filter(it => nameInTitle(it.thread_title, core));
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `${items.length} threads returned, none has "${core}" in its title`,
      };
    }
    return {
      status: 'found', reason: '', records: matches, source_url: url,
      excerpt: `${matches.length} thread title(s) contain "${core}": ` + matches.slice(0, 3).map(m => m.thread_title).join(' | ').slice(0, 400),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', url, String((err && err.message) || err).slice(0, 300));
  }
}
