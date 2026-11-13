export const meta = {
  task: 'TW-qollie.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'url', 'introduction', 'comments_count'],
  canary: { found: '博唯特科技有限公司', not_found: '甲乙丙丁不存在科技股份有限公司' },
};

const SITE = 'https://www.qollie.com';
const ENDPOINT = `${SITE}/graphql`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The same request the site's own search page sends (SearchCompanies). Public, no login, no token.
const QUERY = `query SearchCompanies($kind: String, $keyword: String, $page: Int, $limit: Int) {
  searchCompanies(query: { kind: $kind, keyword: $keyword, limit: $limit, page: $page }) {
    _id
    name
    introduction
    commentsSize
  }
}`;

/** Remove legal-form words (keeps spaces). "博唯特科技股份有限公司" -> "博唯特科技" */
function stripLegal(name) {
  let s = String(name || '').normalize('NFKC').toLowerCase();
  s = s.replace(/\((股|有|股份|有限|公司|股份有限公司|有限公司)\)/g, ' ');
  s = s.replace(/\b(sdn\.?\s*bhd\.?|pte\.?\s*ltd\.?|co\.?\s*,?\s*ltd\.?|ltd\.?|limited|inc\.?|corporation|corp\.?|company|co\.?|llc)(?=\W|$)/g, ' ');
  s = s.replace(/股份有限公司|有限公司|股份有限|有限責任|公司/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Comparison key: legal form, case, spaces and punctuation removed. */
function key(name) {
  return stripLegal(name).replace(/[\s\p{P}\p{S}]+/gu, '');
}

function blockedText(text) {
  return /captcha|cf-chl|challenge-platform|just a moment|access denied/i.test(text);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword ?? '').trim();
  const pageUrl = `${SITE}/search?keyword=${encodeURIComponent(input)}&kind=company`;
  try {
    if (!input) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty keyword' };
    }

    // Search on the name without its legal form (the site writes many names without it), then compare exactly.
    const term = stripLegal(input) || input;
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': SITE,
        'Referer': pageUrl,
      },
      body: JSON.stringify({
        operationName: 'SearchCompanies',
        variables: { kind: 'company', keyword: term, page: 1, limit: 50 },
        query: QUERY,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (blockedText(text)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: text.slice(0, 200) };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: text.slice(0, 200) };
    }

    const list = json?.data?.searchCompanies;
    if (!Array.isArray(list)) {
      const msg = String(json?.errors?.[0]?.message || '').slice(0, 300);
      const reason = /Cannot query field|Unknown argument|Unknown type|Expected|Variable/i.test(msg) ? 'layout_changed' : 'other';
      return { status: 'couldnt_check', reason, records: [], source_url: pageUrl, excerpt: msg || 'no searchCompanies list in response' };
    }

    if (list.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: pageUrl, excerpt: `Qollie search for "${term}": 0 results` };
    }

    const wanted = key(input);
    const matches = list.filter((c) => c && key(c.name) === wanted);
    if (matches.length === 0) {
      const names = list.slice(0, 10).map((c) => c?.name).join(' | ');
      return {
        status: 'not_found', reason: '', records: [], source_url: pageUrl,
        excerpt: `Qollie search for "${term}": ${list.length} result(s), none with this name. ${names}`.slice(0, 500),
      };
    }

    const records = matches.map((c) => ({
      name: c.name,
      company_id: c._id,
      url: `${SITE}/companies/${c._id}`,
      introduction: c.introduction || '',
      comments_count: typeof c.commentsSize === 'number' ? c.commentsSize : null,
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: `Qollie company page for ${records[0].name}: ${records[0].comments_count ?? 0} comment(s)`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: pageUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
