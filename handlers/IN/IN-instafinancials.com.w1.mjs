export const meta = {
  task: 'IN-instafinancials.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'cin', 'status', 'previous_name', 'state', 'city', 'url'],
  canary: { found: 'TATA MOTORS BODY SOLUTIONS LIMITED', not_found: 'श्री राम अनलिस्टेड प्राइवेट लिमिटेड' },
};

// InstaFinancials company search: the homepage search box POSTs to /ajax-caller.aspx/GetCompanyNames with the body
// {strSearch, mode:"SCBN"} and gets {"d":["id;NAME;CIN;isPreviousName;STATE;CITY;STATUS;flag", ...]} back.
// Observed on the live site: the search matches names by prefix, returns at most 6 rows, and finds nothing when the
// legal form is included (e.g. "PRIVATE LIMITED"), so the legal form is removed before searching.
// The company page /company/<slug>-<CIN> is built from the CIN; it is not fetched here.
const SITE = 'https://www.instafinancials.com';
const SEARCH_URL = `${SITE}/ajax-caller.aspx/GetCompanyNames`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_CAP = 6;
const LEGAL_TAIL = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'OPC', 'PUBLIC', 'PLC']);

/** Upper-case words of a name, punctuation removed, "&" read as AND. */
function words(name) {
  return String(name || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

/** The name without its trailing legal form, e.g. "ACME TRADING PVT. LTD." -> ["ACME","TRADING"]. */
function coreWords(name) {
  const w = words(name);
  while (w.length > 1 && LEGAL_TAIL.has(w[w.length - 1])) w.pop();
  return w;
}

const keyOf = (name) => coreWords(name).join('');

const fail = (reason, excerpt) =>
  ({ status: 'couldnt_check', reason, records: [], source_url: SEARCH_URL, excerpt: String(excerpt).slice(0, 500) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = coreWords(keyword).join(' ');
    if (!query) return fail('other', 'no name left after removing the legal form');

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': `${SITE}/`,
      },
      body: `{strSearch:${JSON.stringify(query)},mode:"SCBN"}`,
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      const challenge = /captcha|cf-chl|challenge|access denied|robot/i.test(body);
      return fail(challenge ? 'blocked' : 'layout_changed', body.slice(0, 300));
    }
    if (!json || !Array.isArray(json.d)) return fail('layout_changed', body.slice(0, 300));

    const rows = [];
    for (const raw of json.d) {
      const p = String(raw).split(';');
      if (p.length < 7) return fail('layout_changed', body.slice(0, 300));
      rows.push({ name: p[1], cin: p[2], previous_name: p[3] === 'True', state: p[4], city: p[5], status: p[6] });
    }

    const want = keyOf(keyword);
    const matches = rows.filter((r) => keyOf(r.name) === want);

    if (matches.length === 0) {
      if (rows.length >= SEARCH_CAP) {
        return fail('other', `search for "${query}" returned the maximum ${SEARCH_CAP} rows and none matched exactly, so absence is not proven`);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: `search for "${query}" returned ${rows.length} row(s), none with this name`,
      };
    }

    const records = matches.map((r) => ({
      ...r,
      url: `${SITE}/company/${words(r.name).join('-').toLowerCase() || 'company'}-${r.cin}`,
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: records.map((r) => `${r.name} | CIN ${r.cin} | ${r.status} | ${r.city}, ${r.state}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
