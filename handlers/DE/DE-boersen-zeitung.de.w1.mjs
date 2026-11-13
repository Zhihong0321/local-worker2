export const meta = { task: 'DE-boersen-zeitung.de', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'aliases', 'isin', 'issuer_id', 'country', 'listings', 'ticker', 'url'],
  canary: { found: 'Allianz SE', not_found: 'Zerbrochene Blüten Bäckerei GmbH' } };

// The company search on https://www.boersen-zeitung.de/suche?searchtype=company calls this JSON API from the browser.
// It needs no login and no key. It indexes companies with listed instruments (ISIN, listing, ticker).
const API = 'https://api.prod.boersenzeitung.sprylabprojects.com/api/companies/search?searchString=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ag', 'se', 'gmbh', 'kgaa', 'kg', 'ohg', 'ug', 'mbh', 'co', 'gbr', 'ek', 'plc', 'inc', 'ltd', 'llc', 'corp', 'nv', 'sa', 'spa', 'ab', 'as', 'oyj', 'bv', 'v', 'e']);

/** Name without its trailing legal form (AG, SE, GmbH, ...), so "Allianz SE" and "Allianz" compare equal. */
function core(s) {
  const words = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function toRecord(x) {
  const instruments = Array.isArray(x.instruments) ? x.instruments : [];
  return {
    name: x.name || '',
    aliases: Array.isArray(x.aliases) ? x.aliases.map(a => String(a).trim()).filter(Boolean) : [],
    isin: x.isin || '',
    issuer_id: x.issuerId || '',
    country: x.country || '',
    listings: [...new Set(instruments.flatMap(i => (Array.isArray(i.lists) ? i.lists : [])))],
    ticker: instruments[0]?.germanTicker || '',
    url: x.slug ? new URL(x.slug, 'https://www.boersen-zeitung.de').href : '',
  };
}

/** One search call. Returns { data } (an array) or { fail } (a couldnt_check answer). Never throws. */
async function ask(query) {
  const url = API + encodeURIComponent(query);
  const fail = (reason, excerpt) => ({ fail: { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) } });
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
    const text = await res.text();
    if (/captcha|cf-chl|access denied/i.test(text.slice(0, 2000))) return fail('blocked', 'bot or captcha page');
    let data;
    try { data = JSON.parse(text); } catch { return fail('layout_changed', text.slice(0, 200)); }
    if (!Array.isArray(data)) return fail('layout_changed', 'response is not a JSON list');
    return { data };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', e?.message || e);
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword ?? '').trim();
    const want = core(kw);
    if (!want) return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty company name' };

    // One search call with the name as typed. The site matches names and aliases itself.
    const r = await ask(kw);
    if (r.fail) return r.fail; // a refusal or error is never not_found

    const matched = r.data.filter(x => [x.name, ...(Array.isArray(x.aliases) ? x.aliases : [])]
      .some(n => typeof n === 'string' && core(n) === want));
    if (matched.length > 0) {
      const records = matched.map(toRecord);
      return {
        status: 'found',
        reason: '',
        records,
        source_url: API + encodeURIComponent(kw),
        excerpt: `Börsen-Zeitung company search, ${records.length} match(es): ` + records.map(x => `${x.name} (${x.isin})`).join('; '),
      };
    }

    // The site answered normally but no name matches after normalisation. Near results are listed for a human.
    const near = r.data.slice(0, 3).map(x => x.name).filter(Boolean).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: API + encodeURIComponent(kw),
      excerpt: `0 companies matching "${kw}" in the Börsen-Zeitung company search` + (near ? `; near results: ${near}` : ''),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: API,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
