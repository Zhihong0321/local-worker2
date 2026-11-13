export const meta = { task: 'US-irs.gov', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'ein', 'dba', 'city', 'state', 'country', 'types'],
  canary: { found: 'AMERICAN RED CROSS', not_found: 'ZQXJV NONEXISTENT TRADING LLC' } };

// IRS Tax Exempt Organization Search (TEOS). The page at /app/eos/ is a JavaScript app that calls a JSON endpoint:
//   GET https://apps.irs.gov/teos/searchAll/orgName?orgName=<name>&rows=<n>&page=<0-based page>
// The site sets bot-check cookies on the first visit to /app/eos/, so the handler loads that page first and sends
// those cookies back, the same way a browser does. No login, no captcha, no form submit.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOME = 'https://apps.irs.gov/app/eos/';
const API = 'https://apps.irs.gov/teos/searchAll/orgName';
const ROWS = 100;
const MAX_PAGES = 3;
const LEGAL_FORMS = new Set(['INC', 'INCORPORATED', 'LLC', 'LLP', 'LP', 'LTD', 'LIMITED', 'CORP', 'CORPORATION',
  'CO', 'COMPANY', 'PLLC', 'PC', 'NA']);

/** Upper case, letters and digits only, trailing legal form removed: "Acme Corp." and "ACME CORPORATION" match. */
function normalize(str) {
  const words = String(str || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Cookies from Set-Cookie headers, as "a=1; b=2". */
function cookieHeader(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  return list.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
}

function fail(status, reason, sourceUrl, excerpt) {
  return { status, reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const sourceUrl = `${API}?${new URLSearchParams({ orgName: name, rows: String(ROWS), page: '0' })}`;
  if (!name) return fail('couldnt_check', 'other', HOME, 'empty company name');
  try {
    // 1. First visit: get the bot-check cookies the search API expects.
    const home = await fetch(HOME, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (home.status === 403 || home.status === 429) return fail('couldnt_check', 'blocked', HOME, `HTTP ${home.status}`);
    if (!home.ok) return fail('couldnt_check', 'http_error', HOME, `HTTP ${home.status}`);
    const cookie = cookieHeader(home.headers);
    await home.text().catch(() => '');

    // 2. Search: collect pages (0-based) until every match the site counts has been read, at most MAX_PAGES.
    const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: HOME };
    if (cookie) headers.Cookie = cookie;
    const items = [];
    let count = 0;
    const started = Date.now();
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - started > 30000) break; // keep the whole call under 60 s
      const url = `${API}?${new URLSearchParams({ orgName: name, rows: String(ROWS), page: String(page) })}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', sourceUrl, `HTTP ${res.status}`);
      if (!res.ok) return fail('couldnt_check', 'http_error', sourceUrl, `HTTP ${res.status}`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { return fail('couldnt_check', 'layout_changed', sourceUrl, text.slice(0, 300)); }
      if (!data || typeof data !== 'object' || typeof data.count !== 'number' || !Array.isArray(data.items)) {
        return fail('couldnt_check', 'layout_changed', sourceUrl, JSON.stringify(data).slice(0, 300));
      }
      if (data.message && data.message !== 'success') return fail('couldnt_check', 'other', sourceUrl, data.message);
      count = data.count;
      items.push(...data.items);
      if (data.items.length === 0 || items.length >= count) break;
    }

    // 3. Match the company, not similar words: normalised names must be equal.
    const want = normalize(name);
    const matches = items.filter((it) => normalize(it.name) === want);
    if (matches.length === 0) {
      const similar = items.slice(0, 3).map((it) => it.name).join(' | ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: count === 0 ? `0 results for "${name}"` : `${count} result(s) for "${name}", none with this exact name${similar ? `: ${similar}` : ''}`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records: matches.map((it) => ({
        name: it.name,
        ein: it.ein,
        dba: it.dba || '',
        city: it.city || '',
        state: it.state || '',
        country: it.country || '',
        types: it.types || '',
      })),
      source_url: sourceUrl,
      excerpt: `${matches.length} record(s) named "${matches[0].name}" on IRS TEOS`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', sourceUrl, String(err?.message || err));
  }
}
