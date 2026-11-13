export const meta = {
  task: 'SG-sg.wantedly.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_url', 'wantedly_id', 'mission_statement', 'employee_count', 'post_count', 'project_count'],
  canary: { found: 'Wantedly, Inc.', not_found: '新加坡无名科技私人有限公司' },
};

const SITE = 'https://sg.wantedly.com';
const GQL_URL = 'https://visit-gql.wantedly.com/graphql';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Same query the site's own search page sends (SearchCompanies).
const QUERY = `query SearchCompanies($query: String!, $first: Int!, $after: String = null) @ownerTeam(name: "visit") {
    globalSearchCompanies(query: $query, first: $first, after: $after) {
      totalCount
      edges {
        node {
          id
          name
          avatarUrl
          companyPath

          missionStatement
          origin
          postCount
          projectCount
          employeeCount
          followingState
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Legal forms, in Latin and CJK. Removed from both the typed name and the site's name before comparing.
const CJK_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|私人有限公司|有限公司|股份有限公司|\(株\)|\(有\)|（株）|（有）/g;
const LATIN_FORMS = /\b(pte|ltd|limited|inc|incorporated|llc|llp|corp|corporation|co|company|plc|gmbh|sdn|bhd|kk|pvt|private)\b/g;

/** Normalised comparison key: case, width, punctuation, spaces and legal form ignored. */
function compareKey(str) {
  let s = String(str || '').normalize('NFKC').toLowerCase();
  s = s.replace(CJK_FORMS, ' ').replace(LATIN_FORMS, ' ');
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The typed name with legal form removed, keeping its spacing, used as the site search text. */
function searchText(str) {
  let s = String(str || '').normalize('NFKC');
  s = s.replace(CJK_FORMS, ' ').replace(new RegExp(LATIN_FORMS.source, 'gi'), ' ');
  return s.replace(/[,.()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function blockedPage(html) {
  return /captcha|cf-chl|just a moment|access denied|verify you are human/i.test(html || '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const typed = String(keyword || '').trim();
  const searchPageUrl = typed ? `${SITE}/search?query=${encodeURIComponent(searchText(typed) || typed)}` : SITE;
  try {
    if (!typed) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty company name' };
    }
    const term = searchText(typed) || typed;
    const want = compareKey(typed);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchPageUrl, excerpt: 'no name left after removing the legal form' };
    }

    // Step 1: the search page carries an anonymous API token in its embedded page data.
    const pageRes = await fetch(searchPageUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchPageUrl, excerpt: `HTTP ${pageRes.status}` };
    }
    if (!pageRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchPageUrl, excerpt: `HTTP ${pageRes.status}` };
    }
    const pageHtml = await pageRes.text();
    const dataMatch = pageHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    let token = null;
    try {
      token = JSON.parse(dataMatch[1]).props.pageProps.__apollo.visitApiNodeAuthToken || null;
    } catch {
      token = null;
    }
    if (!token) {
      if (blockedPage(pageHtml)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchPageUrl, excerpt: 'bot check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchPageUrl, excerpt: pageHtml.slice(0, 300) };
    }

    // Step 2: the search itself, the same request the site's search page makes.
    const gqlRes = await fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-wantedly-app-language': 'en',
        'x-wantedly-app-country': 'SG',
        'Origin': SITE,
        'Referer': searchPageUrl,
      },
      body: JSON.stringify({ operationName: 'SearchCompanies', query: QUERY, variables: { query: term, first: 50 } }),
      signal: AbortSignal.timeout(25000),
    });
    if (gqlRes.status === 403 || gqlRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchPageUrl, excerpt: `search HTTP ${gqlRes.status}` };
    }
    if (!gqlRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchPageUrl, excerpt: `search HTTP ${gqlRes.status}` };
    }
    let body;
    try {
      body = await gqlRes.json();
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchPageUrl, excerpt: 'search answer is not JSON' };
    }
    if (body && Array.isArray(body.errors) && body.errors.length) {
      const msg = body.errors.map((e) => String(e && e.message)).join('; ');
      const reason = /unauth|forbidden|permission|not authori[sz]ed|login/i.test(msg) ? 'blocked' : 'other';
      return { status: 'couldnt_check', reason, records: [], source_url: searchPageUrl, excerpt: msg.slice(0, 300) };
    }
    const conn = body && body.data && body.data.globalSearchCompanies;
    if (!conn || !Array.isArray(conn.edges)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchPageUrl, excerpt: JSON.stringify(body).slice(0, 300) };
    }

    // Step 3: keep only entries whose normalised name equals the typed name's.
    const nodes = conn.edges.map((e) => e && e.node).filter(Boolean);
    const matches = nodes.filter((n) => compareKey(n.name) === want);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchPageUrl,
        excerpt: `${conn.totalCount ?? nodes.length} results for "${term}", none with the name "${typed}"`,
      };
    }

    const records = matches.map((n) => ({
      name: n.name,
      company_url: `${SITE}${n.companyPath || ''}`,
      wantedly_id: n.id,
      mission_statement: n.missionStatement || '',
      employee_count: n.employeeCount ?? null,
      post_count: n.postCount ?? null,
      project_count: n.projectCount ?? null,
    }));
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchPageUrl,
      excerpt: `Wantedly company profile "${first.name}" (${first.company_url}); ${first.employee_count ?? '?'} employees listed; mission: ${first.mission_statement}`.slice(0, 500),
    };
  } catch (err) {
    const name = String(err && err.name);
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchPageUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
