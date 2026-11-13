export const meta = {
  task: 'JP-nikkei.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'nik_code', 'securities_code'],
  canary: { found: 'トヨタ自動車', not_found: 'ゼノデンダ株式会社' },
};

const BASE = 'https://www.nikkei.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Nikkei's search returns 0 results for names that still carry a legal form
// (checked: "トヨタ自動車株式会社" -> 0 results, "トヨタ自動車" -> company found), so the legal form is removed before searching.
const LEGAL_FORM = /株式会社|有限会社|合同会社|合名会社|合資会社|\(株\)|\(有\)|\(合\)/g;

/** Query text for the site: legal form removed, spaces collapsed. */
function searchQuery(keyword) {
  return (keyword || '').normalize('NFKC').replace(LEGAL_FORM, ' ').replace(/\s+/g, ' ').trim();
}

/** Name used for comparing: NFKC, legal form removed, no spaces or punctuation, lower case. */
function compareName(name) {
  return (name || '').normalize('NFKC').replace(LEGAL_FORM, '').replace(/[\s.,\-・]/g, '').toLowerCase();
}

function decodeEntities(s) {
  return s.replace(/&#x3D;/gi, '=').replace(/&amp;/gi, '&').replace(/&#39;|&#x27;/gi, "'").replace(/&quot;/gi, '"').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows can abort at process exit while a fetch socket is still closing (exit 127).
  // A short pause lets the sockets close first; tested 3/3 clean exits with it.
  await new Promise((r) => setTimeout(r, 500));
  return answer;
}

async function lookupOnce(keyword) {
  let searchUrl = '';
  try {
    const query = searchQuery(keyword);
    if (!query) return fail('other', BASE, 'no company name left after removing the legal form');
    searchUrl = `${BASE}/search?keyword=${encodeURIComponent(query)}`;

    // Step 1: search page (server-rendered result list).
    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);
    const html = await res.text();

    const emptyMarker = html.match(/data-search-result-empty="(true|false)"/);
    if (!emptyMarker) {
      if (/captcha|access denied|アクセスが集中/i.test(html)) return fail('blocked', searchUrl, 'bot or access check page');
      return fail('layout_changed', searchUrl, html.slice(0, 300));
    }
    const totalText = (html.match(/data-search-total-count>([^<]*)</) || [])[1] || '';
    const total = parseInt(totalText.replace(/,/g, ''), 10);

    // Company cards: one link (nik_code) and one title per card, in the same order.
    const codes = [...html.matchAll(/data-search-recommendation-card-link="[^"]*nik_code(?:&#x3D;|=)(\d+)"/g)].map((m) => m[1]);
    const names = [...html.matchAll(/search__result-recommendation-card-title--company">([^<]*)</g)].map((m) => decodeEntities(m[1]));
    if (codes.length !== names.length) return fail('layout_changed', searchUrl, `company cards: ${codes.length} links, ${names.length} titles`);

    const wanted = compareName(keyword);
    const idx = names.findIndex((n) => compareName(n) === wanted);
    if (idx < 0) {
      // Site answered normally; no company page has this name. News articles alone are not a company record.
      const articles = emptyMarker[1] === 'true' ? 'no results' : `${totalText || '?'} search results (news), no company page with this name`;
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Nikkei search for "${query}": ${articles}`,
      };
    }

    // Step 2: company page, for the code in the ticker title.
    const nikCode = codes[idx];
    const companyUrl = `${BASE}/nkd/company/?nik_code=${nikCode}`;
    const cres = await get(companyUrl);
    if (cres.status === 403 || cres.status === 429) return fail('blocked', companyUrl, `HTTP ${cres.status}`);
    if (!cres.ok) return fail('http_error', companyUrl, `HTTP ${cres.status}`);
    const chtml = await cres.text();

    const title = chtml.match(/<title>【([^】]+)】株価・日経最新ニュース\[([0-9A-Z]{4,5})\]/);
    if (!title) return fail('layout_changed', companyUrl, (chtml.match(/<title>[^<]*<\/title>/) || [''])[0]);
    const pageName = decodeEntities(title[1]);
    if (compareName(pageName) !== wanted) return fail('layout_changed', companyUrl, `page name "${pageName}" differs from "${names[idx]}"`);

    return {
      status: 'found',
      reason: '',
      records: [{ name: pageName, nik_code: nikCode, securities_code: title[2] }],
      source_url: companyUrl,
      excerpt: `${pageName} [${title[2]}] on Nikkei company page (${total} search results)`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', searchUrl || BASE, String(err?.message || err));
  }
}
