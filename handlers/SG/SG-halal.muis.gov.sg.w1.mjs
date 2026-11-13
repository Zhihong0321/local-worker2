export const meta = {
  task: 'SG-halal.muis.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'number', 'scheme', 'sub_scheme', 'type', 'address', 'postal'],
  canary: { found: 'Abang Nasi Goreng (S1) @ Kampung Admiralty', not_found: 'Kedai Makan Tiada Wujud' },
};

const BASE = 'https://halal.muis.gov.sg';
const PAGE_URL = `${BASE}/halal/establishments`;
const API_URL = `${BASE}/api/halal/establishments`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Singapore / Malaysia legal-form endings, removed from the end of a name before comparing.
const LEGAL_END = /\s*,?\s*(pte\.?\s*ltd\.?|private\s+limited|pte\.?|ltd\.?|limited|sdn\.?\s*bhd\.?|bhd\.?|llp|llc|plc|inc\.?)\s*$/i;

function stripLegal(s) {
  let out = (s || '').trim();
  let prev;
  do {
    prev = out;
    out = out.replace(LEGAL_END, '').trim();
  } while (out !== prev && out.length > 0);
  return out || (s || '').trim();
}

// Keeps letters and digits in any script (Chinese, Tamil, Malay, ...), drops case, spaces and punctuation.
function norm(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function failFromError(e, source_url) {
  const name = e && e.name ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', source_url, 'no answer within 25 s');
  return fail('other', source_url, String((e && e.message) || e));
}

// Keeps a cookie jar (name -> value) from every response, so the antiforgery cookie and the security cookies travel together.
function takeCookies(res, jar) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else {
    const one = res.headers.get('set-cookie');
    if (one) list = [one];
  }
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieString(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function looksBlocked(text) {
  return /incapsula incident|request unsuccessful|captcha|access denied/i.test(text || '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  if (!input) return fail('other', PAGE_URL, 'empty company name');

  try {
    const jar = new Map();

    // Step 1: open the establishments page. It sets the antiforgery cookie and holds the matching form token.
    const pageRes = await fetch(PAGE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    takeCookies(pageRes, jar);
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', PAGE_URL, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return fail('http_error', PAGE_URL, `HTTP ${pageRes.status}`);
    if (String(pageRes.url || '').includes('/account/login')) return fail('blocked', PAGE_URL, 'redirected to the e-Service login');

    const pageHtml = await pageRes.text();
    const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
    if (!tokenMatch) {
      if (looksBlocked(pageHtml)) return fail('blocked', PAGE_URL, pageHtml.slice(0, 200));
      return fail('layout_changed', PAGE_URL, 'no request verification token on the establishments page');
    }
    const token = tokenMatch[1];

    // Step 2: the search itself. The site's own page posts {text} with the token in X-CSRF-TOKEN.
    // The name is sent without its legal form, because the directory lists trading names only.
    const base = stripLegal(input);
    const query = base.slice(0, 150);
    const searchRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': token,
        'Origin': BASE,
        'Referer': PAGE_URL,
        'Cookie': cookieString(jar),
      },
      body: JSON.stringify({ text: query, start: 0, length: 500 }),
      signal: AbortSignal.timeout(25000),
    });
    takeCookies(searchRes, jar);
    if (searchRes.status === 403 || searchRes.status === 429) return fail('blocked', PAGE_URL, `HTTP ${searchRes.status}`);
    if (!searchRes.ok) return fail('http_error', PAGE_URL, `HTTP ${searchRes.status} on the search request`);

    const bodyText = await searchRes.text();
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      if (looksBlocked(bodyText)) return fail('blocked', PAGE_URL, bodyText.slice(0, 200));
      return fail('layout_changed', PAGE_URL, 'search answer is not JSON: ' + bodyText.slice(0, 150));
    }
    if (!json || !Array.isArray(json.data) || typeof json.totalRecords !== 'number') {
      return fail('layout_changed', PAGE_URL, 'search JSON has no data/totalRecords: ' + bodyText.slice(0, 150));
    }
    if (json.totalRecords > json.data.length) {
      return fail('other', PAGE_URL, `${json.totalRecords} results, only ${json.data.length} returned in one request`);
    }

    // Step 3: match the company, not just similar words. Compare normalised names with and without legal form.
    const wanted = new Set([norm(input), norm(base)]);
    const matches = json.data.filter((row) => {
      const name = String(row.name || '');
      return wanted.has(norm(name)) || wanted.has(norm(stripLegal(name)));
    });

    if (matches.length === 0) {
      const names = json.data.slice(0, 5).map((r) => r.name).join(' | ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: json.totalRecords === 0
          ? `search "${query}": 0 results`
          : `search "${query}": ${json.totalRecords} results, none with this name (${names})`.slice(0, 300),
      };
    }

    const records = matches.map((r) => ({
      name: r.name || '',
      number: r.number || '',
      scheme: r.schemeText || '',
      sub_scheme: r.subSchemeText || '',
      type: r.typeText || '',
      address: r.address || '',
      postal: r.postal || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE_URL,
      excerpt: `search "${query}": ${matches.length} matching record(s); ${records[0].name}, ${records[0].address}`.slice(0, 300),
    };
  } catch (e) {
    return failFromError(e, PAGE_URL);
  }
}
