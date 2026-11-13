export const meta = {
  task: 'JP-shokuba.mhlw.go.jp',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'corporate_number'],
  canary: { found: '株式会社トヨタレンタリース横浜', not_found: '株式会社ゼロキュウサンヨンゼロ架空商事' },
};

const BASE = 'https://shokuba.mhlw.go.jp';
const TOP_URL = `${BASE}/`;
const SEARCH_URL = `${BASE}/shokuba/search/search060.do`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const NO_RESULT_TEXT = '検索条件に一致するデータがありません';
const DIRECT_ACCESS_TEXT = 'URLからの直接アクセスは禁止です';

/** Japanese and Latin legal-form words that do not change the company identity. */
function normalizeName(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  t = t.replace(/株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|特定非営利活動法人|一般社団法人|一般財団法人|公益社団法人|公益財団法人|\(株\)|\(有\)|\(同\)|\(名\)|\(資\)/g, '');
  t = t.replace(/\b(co\.?\s*,?\s*ltd\.?|ltd\.?|inc\.?|corp\.?|llc\.?)\b/g, '');
  return t.replace(/[\s　\p{P}\p{S}]/gu, '');
}

function decodeText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function absorbCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
    if (m) jar.set(m[1], m[2]);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: source_url || '', excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let resultsUrl = SEARCH_URL;
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return couldnt('other', SEARCH_URL, 'empty keyword');

    const jar = new Map();

    // Step 1: free-word search form. The site answers with a 302 to its results page and sets a session cookie.
    const post = await fetch(SEARCH_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        'Accept': ACCEPT,
        'Accept-Language': 'ja,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': TOP_URL,
        'Origin': BASE,
      },
      body: new URLSearchParams({ searchKeyWords: kw }).toString(),
      signal: AbortSignal.timeout(25000),
    });
    absorbCookies(post, jar);
    await post.arrayBuffer().catch(() => {});

    if (post.status === 403 || post.status === 429) {
      return couldnt('blocked', SEARCH_URL, `HTTP ${post.status}`);
    }
    const location = post.headers.get('location');
    if (post.status < 300 || post.status >= 400 || !location) {
      return couldnt(post.ok ? 'layout_changed' : 'http_error', SEARCH_URL, `search POST answered HTTP ${post.status}, no redirect`);
    }
    resultsUrl = new URL(location, SEARCH_URL).href;

    // Step 2: the results page (first 30 hits, in the site's default order).
    const res = await fetch(resultsUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': ACCEPT,
        'Accept-Language': 'ja,en;q=0.8',
        'Referer': SEARCH_URL,
        'Cookie': cookieHeader(jar),
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return couldnt('blocked', resultsUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return couldnt('http_error', resultsUrl, `HTTP ${res.status}`);
    }
    const html = await res.text();

    if (html.includes(NO_RESULT_TEXT)) {
      return { status: 'not_found', reason: '', records: [], source_url: resultsUrl, excerpt: NO_RESULT_TEXT };
    }
    if (html.includes(DIRECT_ACCESS_TEXT)) {
      return couldnt('other', resultsUrl, 'site refused the results page as a direct access');
    }

    const countMatch = html.match(/([\d,]+)件中/);
    const linkRe = /<a class="corporate-name-link detail" hojinNo="(\d+)">([\s\S]*?)<\/a>/g;
    const hits = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      hits.push({ corporate_number: m[1], name: decodeText(m[2]) });
    }
    if (!countMatch && hits.length === 0) {
      return couldnt('layout_changed', resultsUrl, decodeText(html).slice(0, 300));
    }

    const total = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : hits.length;
    const want = normalizeName(kw);
    const seen = new Set();
    const matches = hits.filter((h) => {
      if (normalizeName(h.name) !== want || seen.has(h.corporate_number)) return false;
      seen.add(h.corporate_number);
      return true;
    });

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((h) => ({ name: h.name, corporate_number: h.corporate_number })),
        source_url: resultsUrl,
        excerpt: `${total} hit(s); exact name match: ${matches.map((h) => h.name).join(' / ')}`,
      };
    }

    // The exact name may sit on a later page we do not read: do not call that "not listed".
    if (total > hits.length) {
      return couldnt('other', resultsUrl, `${total} hits, exact name not on the first page (${hits.length} shown)`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: resultsUrl,
      excerpt: `${total} hit(s), none with the same normalised name`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', resultsUrl, String(err?.message || err));
  }
}
