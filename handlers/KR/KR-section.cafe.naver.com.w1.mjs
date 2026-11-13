export const meta = {
  task: 'KR-section.cafe.naver.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['cafe_name', 'cafe_id', 'article_id', 'subject', 'write_date', 'url', 'snippet'],
  canary: { found: '삼성전자', not_found: '드림아이스테크놀로지마블' },
};

// Naver Cafe section search: a JSON API behind the public search page. It returns cafe posts, not company
// registry records. "found" therefore means: posts on the site that name the company.
const API = 'https://apis.cafe.naver.com/search/v1.0/section/search/articles';
const SEARCH_PAGE = 'https://section.cafe.naver.com/ca-fe/home/search?q=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 50;
const LEGAL_FORMS = /주식회사|유한책임회사|유한회사|합자회사|합명회사|사단법인|재단법인|\(주\)|\(유\)|\(사\)|\(재\)|㈜|㈔|\b(?:co\.?\s*,?\s*ltd\.?|inc\.?|corp\.?|llc|limited)\b/gi;

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

// Lower case, keep only letters and digits (Hangul and Latin), so spacing and punctuation do not matter.
function squash(s) {
  return (s || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = SEARCH_PAGE + encodeURIComponent(String(keyword || ''));
  try {
    // Legal form is removed before searching and before comparing: "ACME 주식회사" is searched as "ACME".
    const core = String(keyword || '').replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();
    const name = squash(core);
    if (name.length < 2) {
      return fail('other', sourceUrl, 'name too short to match safely after removing the legal form');
    }

    const apiUrl = `${API}?query=${encodeURIComponent(core)}&page=1&perPage=${PER_PAGE}`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'X-Cafe-Product': 'pc',
        'Referer': 'https://section.cafe.naver.com/',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return fail('blocked', sourceUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return fail('http_error', sourceUrl, `HTTP ${res.status}`);
    }

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(/captcha|보안문자|접근이 제한/i.test(text) ? 'blocked' : 'layout_changed', sourceUrl, text.slice(0, 300));
    }

    const result = body && body.result;
    if (!result || !Array.isArray(result.articleList)) {
      return fail('layout_changed', sourceUrl, JSON.stringify(body).slice(0, 300));
    }

    const records = [];
    for (const entry of result.articleList) {
      const it = entry && entry.item;
      if (!it) continue;
      const subject = clean(it.subject);
      const content = clean(it.content);
      if (!squash(`${subject} ${content}`).includes(name)) continue;
      const cafeId = it.cafeId;
      const articleId = it.articleId;
      const url = typeof it.linkUrl === 'string' && it.linkUrl.startsWith('https://cafe.naver.com/')
        ? it.linkUrl
        : `https://cafe.naver.com/ArticleRead.nhn?clubid=${cafeId}&articleid=${articleId}`;
      records.push({
        cafe_name: clean(it.cafeName),
        cafe_id: cafeId,
        article_id: articleId,
        subject,
        write_date: it.writeDate || '',
        url,
        snippet: content.slice(0, 300),
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `none of the ${result.articleList.length} posts returned for "${core}" name the company`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: records[0].subject,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', sourceUrl, String((err && err.message) || err));
  }
}
