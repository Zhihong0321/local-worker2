export const meta = {
  task: 'TW-taiwantrade.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'url', 'company_type', 'location', 'create_year', 'certification', 'taitra_check', 'e_portal_years', 'total_revenue', 'employees', 'main_market'],
  canary: { found: 'FOXCONN INTERNATIONAL CO., LTD.', not_found: '艾克梅國際股份有限公司' },
};

// The site's company search page is a client-rendered Angular app. Its results come from the site's own GraphQL
// endpoint, which the page calls with the operation below (copied from the bundle the page loads).
const API = 'https://aem-apollo.taiwantrade.com/graphql';
const SITE_SEARCH = 'https://www.taiwantrade.com/suppliers/search.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUERY = 'query CompanySearchPage($searchType: String, $did: Int!, $condition: SearchCondition!) { companySearch(searchType: $searchType, did: $did, condition: $condition) { companyResult { pageInfo { total totalPage pageSize currentPage } companies { seq employee isTaitraCheck coEpYears companyName companyType companyId companyUrl createYear companyCertification location mainMarket totalRevenue cfaImg } } } }';
const LANGUAGE_ID = 42; // English, as in the page's own requests
const PAGE_SIZE = 100;
const MAX_EXTRA_PAGES = 3;
const DEADLINE_MS = 40000; // leave room for the 60 s limit

function clean(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Legal forms are removed on both sides before comparing, so "ACME TRADING SDN BHD" matches "ACME TRADING CO., LTD.".
const LEGAL_ZH = /股份有限公司|有限公司|公司/g;
const LEGAL_EN = /\b(co|company|ltd|limited|inc|incorporated|corp|corporation|llc|plc|gmbh|sdn|bhd|pte|pvt|pty|sa|bv|ag|lp|llp|the)\b/g;
function matchKey(str) {
  return clean(str).toLowerCase().replace(LEGAL_ZH, ' ').replace(LEGAL_EN, ' ').replace(/[^a-z0-9㐀-鿿]/g, '');
}

// The search text sent to the site: the name without its legal form (the site matches the trading name).
function searchText(keyword) {
  const core = clean(keyword).replace(LEGAL_ZH, ' ').replace(/\b(co|company|ltd|limited|inc|incorporated|corp|corporation|llc|plc|gmbh|sdn|bhd|pte|pvt|pty)\b\.?/gi, ' ');
  return clean(core.replace(/[,.]+/g, ' ')) || clean(keyword);
}

function blockedOrLayout(text) {
  return /access denied|captcha|forbidden|akamai|bot/i.test(text) ? 'blocked' : 'layout_changed';
}

async function fetchPage(text, startPage) {
  const variables = { searchType: 'company', did: 2, condition: { keyword: text, languageId: LANGUAGE_ID, maxResults: PAGE_SIZE, startPage } };
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ operationName: 'CompanySearchPage', query: QUERY, variables }),
    signal: AbortSignal.timeout(25000),
  });
  return res;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const siteUrl = `${SITE_SEARCH}?word=${encodeURIComponent(keyword)}&type=company`;
  const started = Date.now();
  try {
    const text = searchText(keyword);
    if (!text) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: siteUrl, excerpt: 'empty company name' };
    }

    const companies = [];
    let pageInfo = null;
    for (let page = 1; ; page++) {
      const res = await fetchPage(text, page);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: siteUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: siteUrl, excerpt: `HTTP ${res.status}` };
      }
      const body = await res.text();
      let json;
      try { json = JSON.parse(body); } catch {
        return { status: 'couldnt_check', reason: blockedOrLayout(body), records: [], source_url: siteUrl, excerpt: body.slice(0, 300) };
      }
      const result = json && json.data && json.data.companySearch && json.data.companySearch.companyResult;
      if (!result || !Array.isArray(result.companies)) {
        const msg = json && json.errors && json.errors[0] ? json.errors[0].message : 'no companySearch.companyResult in the answer';
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: siteUrl, excerpt: clean(msg).slice(0, 300) };
      }
      pageInfo = result.pageInfo || {};
      companies.push(...result.companies);
      const totalPage = Number(pageInfo.totalPage) || 1;
      if (page >= totalPage || page > MAX_EXTRA_PAGES || Date.now() - started > DEADLINE_MS) break;
    }

    const want = matchKey(keyword);
    const matches = companies.filter(c => matchKey(c.companyName) === want && want !== '');

    if (matches.length === 0) {
      const near = companies.slice(0, 5).map(c => clean(c.companyName)).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: siteUrl,
        excerpt: `0 company names match "${keyword}" (site total ${pageInfo ? pageInfo.total : 0}${near ? '; nearest: ' + near : ''})`,
      };
    }

    const records = matches.map(c => ({
      name: clean(c.companyName),
      company_id: c.companyId || '',
      url: c.companyUrl || '',
      company_type: c.companyType || '',
      location: c.location || '',
      create_year: c.createYear || '',
      certification: clean(c.companyCertification),
      taitra_check: c.isTaitraCheck === true,
      e_portal_years: c.coEpYears || 0,
      total_revenue: c.totalRevenue || '',
      employees: c.employee || '',
      main_market: c.mainMarket || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url || siteUrl,
      excerpt: records.map(r => `${r.name} | id ${r.company_id} | ${r.location}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: siteUrl,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
