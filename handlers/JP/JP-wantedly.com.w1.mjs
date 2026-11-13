export const meta = {
  task: 'JP-wantedly.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'company_url', 'mission_statement', 'employee_count', 'post_count', 'project_count'],
  canary: { found: 'ソニー株式会社', not_found: '株式会社ヌルポインタ架空商事' },
};

const SITE = 'https://www.wantedly.com';
const GQL_URL = 'https://visit-gql.wantedly.com/graphql';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;
const QUERY = `query SearchCompanies($query: String!, $first: Int!, $after: String) {
  globalSearchCompanies(query: $query, first: $first, after: $after) {
    totalCount
    edges { node { id name companyPath missionStatement employeeCount postCount projectCount } }
  }
}`;

// Legal forms do not change which company it is, so they are dropped before comparing.
const LEGAL_JA = ['特定非営利活動法人', '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人', '社団法人', '財団法人',
  '学校法人', '医療法人', '株式会社', '有限会社', '合同会社', '合名会社', '合資会社', '相互会社'];
const LEGAL_EN = /\b(co\.?,?\s*ltd\.?|corporation|corp\.?|inc\.?|incorporated|llc|l\.l\.c\.?|ltd\.?|k\.k\.?|kk|gk|company)\b/g;

/** Normalised form of a company name: width, case, legal form and punctuation removed. */
export function normName(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase(); // ㈱ -> (株), full-width letters -> half-width
  t = t.replace(/\((株|有|合|資|名)\)/g, ' ');
  for (const f of LEGAL_JA) t = t.split(f).join(' ');
  t = t.replace(LEGAL_EN, ' ');
  return t.replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  // On Windows Node, exiting right after a POST response can abort while the socket is still closing.
  // A short pause lets it close first. Costs 0.3 s.
  await new Promise((r) => setTimeout(r, 300));
  return result;
}

async function lookupOnce(keyword) {
  const searchUrl = `${SITE}/search?q=${encodeURIComponent(keyword)}`;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 300) });
  try {
    const want = normName(keyword);
    if (!want) return fail('other', 'the name is empty after removing the legal form and punctuation');

    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': UA,
        'Origin': SITE,
        'Referer': searchUrl,
      },
      body: JSON.stringify({ operationName: 'SearchCompanies', query: QUERY, variables: { query: keyword, first: PAGE } }),
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(/captcha|challenge|access denied/i.test(text) ? 'blocked' : 'layout_changed', text.slice(0, 200));
    }
    const search = json?.data?.globalSearchCompanies;
    if (!search || !Array.isArray(search.edges)) {
      return fail('layout_changed', json?.errors?.[0]?.message || text.slice(0, 200));
    }

    const matches = search.edges.map((e) => e?.node).filter((n) => n && normName(n.name) === want);
    if (matches.length === 0) {
      // Wantedly lists Japanese names. An English-only name that did not match may still be listed under its
      // Japanese name, so a miss cannot be called not_found.
      if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(keyword)) {
        return fail('other', `no listed name matches "${keyword}", and the name has no Japanese characters; it may be listed in Japanese`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `No listed company name matches "${keyword}" among the top ${search.edges.length} of ${search.totalCount} search results`,
      };
    }

    const records = matches.map((n) => ({
      name: n.name,
      company_url: n.companyPath ? SITE + n.companyPath : '',
      mission_statement: n.missionStatement || '',
      employee_count: n.employeeCount ?? null,
      post_count: n.postCount ?? null,
      project_count: n.projectCount ?? null,
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].company_url || searchUrl,
      excerpt: records.map((r) => `${r.name} ${r.company_url}`).join(' | ').slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
