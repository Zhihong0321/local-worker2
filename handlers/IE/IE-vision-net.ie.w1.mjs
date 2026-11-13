export const meta = {
  task: 'IE-vision-net.ie',
  want: 'w1',
  tier: 2,
  method: 'other',
  pdf: false,
  input: 'company name',
  fields: ['name', 'record_type', 'registration_number', 'status'],
  canary: { found: 'Nextgen Digital Innovations Limited', not_found: 'Qqqxz Vvwwkk Tttt Limited' },
};

const BASE = 'https://www.vision-net.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped before comparing names (Irish and UK forms).
const LEGAL_WORDS = new Set(['limited', 'ltd', 'dac', 'plc', 'unlimited', 'teoranta', 'company', 'designated', 'activity', 'cuideachta', 'ctr']);

/** Case, accents, punctuation and legal form removed, so only the core name is compared. */
function normalize(str) {
  const words = String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_WORDS.has(w));
  return words.join('');
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Cookie pairs from the page's Set-Cookie headers, in the form the next request sends back. */
function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return list.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const pageUrl = `${BASE}/freeSearch/?irishCompanyName=${encodeURIComponent(name)}&s=${encodeURIComponent(name)}`;
  const searchUrl = `${BASE}/ajaxSearch/searchAllFree/${encodeURIComponent(name)}`;
  try {
    const wanted = normalize(name);
    if (!wanted) return couldnt('other', pageUrl, 'keyword has no letters or digits');

    // Step 1: the free-search page sets the session cookie the search answer needs.
    const pageRes = await fetch(`${BASE}/freeSearch/`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    await pageRes.text();
    if (pageRes.status === 403 || pageRes.status === 429) {
      return couldnt('blocked', pageUrl, `HTTP ${pageRes.status} on the free-search page`);
    }
    if (!pageRes.ok) return couldnt('http_error', pageUrl, `HTTP ${pageRes.status} on the free-search page`);
    if (new URL(pageRes.url).pathname.startsWith('/login')) {
      return couldnt('blocked', pageUrl, 'free-search page redirected to the login page');
    }
    const cookie = cookieHeader(pageRes);

    // Step 2: the search answer for the name.
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${BASE}/freeSearch/`,
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429 || res.headers.get('x-vn-challenge-required')) {
      await res.text();
      return couldnt('blocked', pageUrl, `HTTP ${res.status}, challenge header ${res.headers.get('x-vn-challenge-required') || 'none'}`);
    }
    if (!res.ok) {
      await res.text();
      return couldnt('http_error', pageUrl, `HTTP ${res.status}`);
    }

    const body = (await res.text()).trim();
    if (!body.startsWith('null') || /<html|<!doctype/i.test(body)) {
      return couldnt('layout_changed', pageUrl, body.slice(0, 200));
    }

    // Answer format: "null&&cs||<name>||<number>||<status>&&bn||<name>||<number>||<status>..."
    // cs = company, bn = business name. The site also returns near-matches, so names are compared here.
    const all = body.split('&&').slice(1).map((e) => e.split('||'))
      .filter((p) => p.length >= 3 && (p[0] === 'cs' || p[0] === 'bn') && p[1] && p[1].trim())
      .map((p) => ({
        name: p[1].trim(),
        record_type: p[0] === 'cs' ? 'company' : 'business_name',
        registration_number: (p[2] || '').trim(),
        status: (p[3] || '').trim(),
      }));

    const matches = all.filter((r) => normalize(r.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: `Site answered with ${all.length} near-match entries; none has the name "${name}"`,
      };
    }
    const first = matches[0];
    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: pageUrl,
      excerpt: `${first.name} (${first.record_type}, ${first.registration_number}, ${first.status})`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', pageUrl, String(err?.message || err));
  }
}
