export const meta = {
  task: 'AU-mara.gov.au', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['business_name', 'agent_name', 'suburb', 'state', 'country', 'status', 'registration_state', 'contact_id'],
  canary: { found: 'Kinetic Migration Services Pty Ltd', not_found: 'Zebra Xylophone Pty Ltd' },
};

// OMARA "Search for registered migration agents" lives on the Power Pages portal. The page loads its results from a
// JSON grid endpoint, which needs the session cookies from the page and an anti-forgery token from /_layout/tokenhtml.
const PAGE_URL = 'https://portal.mara.gov.au/search-the-register-of-migration-agents/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 50;
const MAX_PAGES = 4;          // at most 200 rows read per lookup
const NO_NEW_REQUEST_AFTER_MS = 30000; // every fetch has its own 25 s timeout, so the call stays under 60 s
const LEGAL_WORDS = new Set(['PTY', 'LTD', 'LIMITED', 'INC', 'INCORPORATED', 'LLC', 'PL', 'PTE']);

/** Upper-case, "&" as AND, no punctuation, no legal form. Two names match only if these strings are equal. */
function normalize(str) {
  const s = String(str || '').toUpperCase().replace(/&/g, ' AND ').replace(/\bP\s*\/?\s*L\b/g, ' ');
  return s.replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

/** The text sent to the site's search: the typed name with its legal-form words removed, punctuation kept. */
function searchTerm(keyword) {
  const words = String(keyword).trim().split(/\s+/).filter((w) => !LEGAL_WORDS.has(w.toUpperCase().replace(/[^A-Z]/g, '')));
  return words.join(' ') || String(keyword).trim();
}

function attr(rec, name) {
  const a = (rec.Attributes || []).find((x) => x.Name === name || x.Name.endsWith('.' + name));
  if (!a) return '';
  let v = typeof a.Value === 'string' ? a.Value : String(a.FormattedValue || (a.Value && a.Value.Name) || '');
  v = v.trim();
  return v === '-' ? '' : v;
}

function rowOf(rec) {
  const first = attr(rec, 'firstname');
  const last = attr(rec, 'lastname');
  return {
    business_name: attr(rec, 'dlg_contactcompanyname'),
    agent_name: [first, last].filter(Boolean).join(' '),
    suburb: attr(rec, 'address1_city'),
    state: attr(rec, 'address1_stateorprovince'),
    country: attr(rec, 'address1_country'),
    status: attr(rec, 'statuscode'),
    registration_state: attr(rec, 'statecode'),
    contact_id: attr(rec, 'contactid') || String(rec.Id || ''),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const fail = (reason, excerpt, src = PAGE_URL) =>
    ({ status: 'couldnt_check', reason, records: [], source_url: src, excerpt: String(excerpt || '').slice(0, 300) });
  try {
    const name = String(keyword || '').trim();
    if (!name) return fail('other', 'empty company name');
    const late = () => Date.now() - started > NO_NEW_REQUEST_AFTER_MS;

    const jar = new Map();
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const storeCookies = (res) => {
      let list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (!list.length) list = (res.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
      for (const c of list) {
        const kv = c.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    };
    const get = async (url, opts = {}) => {
      const headers = { 'User-Agent': UA, 'Accept-Language': 'en-AU,en;q=0.9', ...(opts.headers || {}) };
      if (jar.size) headers.Cookie = cookieHeader();
      const res = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body, signal: AbortSignal.timeout(25000) });
      storeCookies(res);
      return res;
    };

    // 1. The search page: session cookies, the grid's data URL and its secure view configuration.
    const pageRes = await get(PAGE_URL, { headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } });
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', 'HTTP ' + pageRes.status);
    if (!pageRes.ok) return fail('http_error', 'HTTP ' + pageRes.status);
    const html = await pageRes.text();
    const dataAttr = (html.match(/data-get-url="([^"]*entity-grid-data[^"]*)"/) || [])[1];
    const layoutB64 = (html.match(/data-view-layouts='([^']+)'/) || [])[1];
    if (!dataAttr || !layoutB64) return fail('layout_changed', 'search page has no register grid: ' + html.slice(0, 120));
    let layout = null;
    try {
      const bytes = Uint8Array.from(atob(layoutB64), (c) => c.charCodeAt(0));
      layout = JSON.parse(new TextDecoder().decode(bytes))[0];
    } catch { layout = null; }
    if (!layout || !layout.Base64SecureConfiguration) return fail('layout_changed', 'register grid has no view configuration');
    const gridUrl = new URL(dataAttr.replace(/&amp;/g, '&'), PAGE_URL).href;

    // 2. Anti-forgery token for the grid call.
    if (late()) return fail('timeout', 'the register search did not finish in time');
    const tokRes = await get(new URL('/_layout/tokenhtml', PAGE_URL).href, {
      headers: { Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: PAGE_URL, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
    });
    if (tokRes.status === 403 || tokRes.status === 429) return fail('blocked', 'token HTTP ' + tokRes.status);
    if (!tokRes.ok) return fail('http_error', 'token HTTP ' + tokRes.status);
    const tokHtml = await tokRes.text();
    const token = (tokHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1];
    if (!token) return fail('layout_changed', 'no anti-forgery token: ' + tokHtml.slice(0, 120));

    // 3. Search by business name ("Business Name" filter), reading the result pages.
    const term = searchTerm(name);
    const want = normalize(name);
    const seen = [];
    const matches = [];
    let cookie = null;
    let more = true;
    let truncated = false;
    for (let page = 1; more; page++) {
      if (page > MAX_PAGES) { truncated = true; break; }
      if (late()) return fail('timeout', 'the register search did not finish in time', gridUrl);
      const metaFilter = new URLSearchParams([['0', ''], ['1', ''], ['2', ''], ['3', term], ['4', ''], ['4', ''], ['4', ''], ['4', '']]).toString();
      const body = {
        viewName: null, columns: null, base64SecureConfiguration: layout.Base64SecureConfiguration,
        sortExpression: layout.SortExpression || '', search: null, filter: null, metaFilter,
        page, pageSize: PAGE_SIZE, pagingCookie: cookie, timezoneOffset: 0, customParameters: [],
        entityName: 'contact', entityId: null, nlSearchFilter: null,
      };
      const res = await get(gridUrl, {
        method: 'POST', body: JSON.stringify(body),
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json; charset=utf-8',
          __RequestVerificationToken: token, 'X-Requested-With': 'XMLHttpRequest', Referer: PAGE_URL,
          'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
        },
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', 'register search HTTP ' + res.status, gridUrl);
      if (!res.ok) return fail('http_error', 'register search HTTP ' + res.status, gridUrl);
      const txt = await res.text();
      if (!txt.trim()) return fail('other', 'register search gave an empty answer (refused or not ready)', gridUrl);
      let data = null;
      try { data = JSON.parse(txt); } catch { data = null; }
      if (!data || !Array.isArray(data.Records)) return fail('layout_changed', 'register answer was not a record list: ' + txt.slice(0, 120), gridUrl);
      for (const rec of data.Records) {
        const row = rowOf(rec);
        seen.push(row);
        if (normalize(row.business_name) === want) matches.push(row);
      }
      more = !!data.MoreRecords && data.Records.length > 0;
      cookie = data.NextPagePagingCookie || null;
    }

    if (matches.length) {
      return {
        status: 'found', reason: '', records: matches, source_url: PAGE_URL,
        excerpt: `Register search by business name "${term}": ${matches.length} record(s) for "${matches[0].business_name}"` + (truncated ? ' (list cut at 200 rows)' : ''),
      };
    }
    if (truncated) return fail('other', `more than ${seen.length} rows matched "${term}"; the exact name was not reached`, gridUrl);
    const similar = [...new Set(seen.map((r) => r.business_name).filter(Boolean))].slice(0, 5);
    return {
      status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
      excerpt: `Register search by business name "${term}": 0 exact matches` + (similar.length ? `; similar names: ${similar.join(' | ')}` : '; 0 rows returned'),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String(err && err.message ? err.message : err));
  }
}
