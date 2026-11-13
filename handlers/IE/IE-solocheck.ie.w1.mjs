export const meta = {
  task: 'IE-solocheck.ie',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_number', 'status', 'company_size', 'registered_address', 'incorporated', 'trading_name', 'principal_activity', 'url'],
  canary: { found: 'Meade Farm Limited', not_found: 'Comhlacht Neamhlisteáilte Teoranta' },
};

const BASE = 'https://www.solocheck.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words, removed only at the END of a name (so "Public House Ltd" keeps "House").
const LEGAL = new Set(['limited', 'ltd', 'designated', 'activity', 'company', 'dac', 'unlimited', 'uc', 'public', 'plc', 'teoranta', 'teo', 'clg', 'cuideachta']);
const FETCH_TIMEOUT = 25000;
// Each fetch can take up to 25 s; a fetch started after this many ms could end past the 60 s limit.
const LAST_START_MS = 33000;
const MAX_DETAIL = 3;

function tokens(str) {
  return (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean);
}

/** Name without the trailing legal form, all lower case and no punctuation. */
function normaliseName(str) {
  const t = tokens(str);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join('');
}

/** The keyword as typed, with a trailing legal form removed, for the site's search box. */
function searchName(keyword) {
  const words = keyword.trim().split(/\s+/);
  while (words.length > 1 && LEGAL.has(tokens(words[words.length - 1])[0] || '')) words.pop();
  return words.join(' ');
}

function cleanText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .replace(/(\s*,\s*)+/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

/** Merge the cookies we already hold with any Set-Cookie headers of a response. */
function mergeCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const map = new Map();
  for (const part of (jar || '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const sc of list) {
    const pair = sc.split(';')[0].trim();
    const i = pair.indexOf('=');
    if (i > 0) map.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function get(url, cookies, referer) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IE,en;q=0.9',
  };
  if (cookies) headers.Cookie = cookies;
  if (referer) headers.Referer = referer;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const text = await res.text();
  return { res, text, cookies: mergeCookies(cookies, res) };
}

function isBotWall(text) {
  return /g-recaptcha|hcaptcha|cf-chl|Attention Required!|Just a moment\.\.\./i.test(text);
}

/** Company rows of the first results table (the company table comes before the business-name table). */
function parseCompanyRows(html) {
  const table = html.match(/<table class="searchResults">[\s\S]*?<\/table>/i);
  if (!table) return [];
  const rows = table[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const a = row.match(/<a[^>]*href="(\/Irish-Company\/[^"]*?-(\d+))"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const st = row.match(/<div class="status[^"]*">\s*<span class="status"><\/span>([\s\S]*?)<\/div>/i);
    out.push({
      name: cleanText(a[3]),
      url: BASE + a[1],
      company_number: a[2],
      status: st ? cleanText(st[1]) : '',
    });
  }
  return out;
}

/** Vitals of one company page. Missing fields are left empty; the search row still stands. */
function parseDetail(html) {
  const field = (label) => {
    const m = html.match(new RegExp(label + ':<\\/span>([\\s\\S]*?)<\\/li>', 'i'));
    return m ? cleanText(m[1]) : '';
  };
  const founding = html.match(/itemprop="foundingDate" content="([^"]+)"/i);
  return {
    name: field('Company Name'),
    company_number: field('Company Number'),
    status: field('Current Status'),
    company_size: field('Company Size'),
    registered_address: field('Registered Address'),
    trading_name: field('May Trade As'),
    principal_activity: field('Principal Activity'),
    incorporated: founding ? founding[1] : '',
    vitals_seen: /Company Vitals/i.test(html),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) });
  const name = String(keyword || '').trim();
  const homeUrl = `${BASE}/`;
  let searchUrl = '';

  try {
    if (!name) return fail('other', homeUrl, 'empty company name');

    // 1. Session: the search needs the JSESSIONID cookie and the vstoken from the same session.
    // 2. Search: the site lists active companies by default; incDiss=true adds dissolved ones.
    let cookies = '';
    let page = null;
    for (let attempt = 0; attempt < 2 && !page; attempt++) {
      if (elapsed() > LAST_START_MS) return fail('timeout', homeUrl, 'the site was too slow for two steps');
      const home = await get(homeUrl, cookies, null);
      if (home.res.status === 403 || home.res.status === 429) return fail('blocked', homeUrl, `HTTP ${home.res.status}`);
      if (!home.res.ok) return fail('http_error', homeUrl, `HTTP ${home.res.status}`);
      if (isBotWall(home.text)) return fail('blocked', homeUrl, 'bot check page');
      const vs = home.text.match(/name="vstoken" value="([0-9a-f]+)"/i);
      if (!vs) return fail('layout_changed', homeUrl, home.text.slice(0, 300));
      cookies = home.cookies;

      if (elapsed() > LAST_START_MS) return fail('timeout', homeUrl, 'the site was too slow for two steps');
      searchUrl = `${BASE}/search?companyName=${encodeURIComponent(searchName(name))}&vstoken=${vs[1]}&incDiss=true`;
      const s = await get(searchUrl, cookies, homeUrl);
      if (s.res.status === 403 || s.res.status === 429) return fail('blocked', searchUrl, `HTTP ${s.res.status}`);
      if (!s.res.ok) return fail('http_error', searchUrl, `HTTP ${s.res.status}`);
      if (isBotWall(s.text)) return fail('blocked', searchUrl, 'bot check page');
      cookies = s.cookies;
      if (/Session Token Error|session may have timed out/i.test(s.text)) continue; // ask again with a fresh session
      page = s;
    }
    if (!page) return fail('other', searchUrl, 'the site kept rejecting the search session');

    const rows = parseCompanyRows(page.text);
    if (rows.length === 0) {
      if (/returned no results/i.test(page.text)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'Sorry, your search returned no results.' };
      }
      return fail('layout_changed', searchUrl, page.text.slice(0, 300));
    }

    // 3. Match the company, not similar words: normalised names must be equal.
    const want = normaliseName(name);
    const matches = rows.filter((r) => normaliseName(r.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${rows.length} result(s) for "${searchName(name)}", none with the name "${name}"`,
      };
    }

    // 4. Vitals page of each match (optional: the search row alone is kept if the page cannot be read).
    const records = [];
    for (let i = 0; i < matches.length && i < 5; i++) {
      const m = matches[i];
      let rec = { name: m.name, company_number: m.company_number, status: m.status, company_size: '', registered_address: '', incorporated: '', trading_name: '', principal_activity: '', url: m.url };
      if (i < MAX_DETAIL && elapsed() <= LAST_START_MS) {
        try {
          const d = await get(m.url, cookies, searchUrl);
          if (d.res.ok && !isBotWall(d.text)) {
            const p = parseDetail(d.text);
            if (p.vitals_seen) {
              rec = {
                name: p.name || m.name,
                company_number: p.company_number || m.company_number,
                status: p.status || m.status,
                company_size: p.company_size,
                registered_address: p.registered_address,
                incorporated: p.incorporated,
                trading_name: p.trading_name,
                principal_activity: p.principal_activity,
                url: m.url,
              };
            }
          }
        } catch (_) {
          // keep the search-row record
        }
      }
      records.push(rec);
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.url,
      excerpt: `${first.name} | company number ${first.company_number} | ${first.status}${first.registered_address ? ' | ' + first.registered_address : ''}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', searchUrl || homeUrl, String(err?.message || err));
  }
}
