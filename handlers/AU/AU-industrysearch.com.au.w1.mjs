export const meta = {
  task: 'AU-industrysearch.com.au',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'postal_address', 'keywords', 'profile_url', 'supplier_id'],
  canary: { found: 'Caterpillar of Australia', not_found: 'Quorvelt Shandrik Holdings Pty Ltd' },
};

const BASE = 'https://www.industrysearch.com.au';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped before comparing names.
const LEGAL_FORMS = new Set(['pty', 'ltd', 'limited', 'proprietary', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation', 'llc', 'plc']);

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Lower-case, "&" to "and", drop punctuation and legal-form words. */
function coreName(str) {
  const words = String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w));
  return words.join('');
}

/** Query text: the name with the legal form removed, original spelling kept. */
function searchText(keyword) {
  const words = cleanText(keyword).split(' ').filter((w) => {
    const bare = w.toLowerCase().replace(/[^a-z]/g, '');
    return bare && !LEGAL_FORMS.has(bare);
  });
  return words.join(' ') || cleanText(keyword);
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause at the end lets the HTTP sockets close before the runner calls process.exit();
 * without it, Node 24 on Windows aborts with a libuv assertion (exit code 127) after the answer is printed.
 */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await lookupOnce(keyword);
  } catch (err) {
    answer = fail('other', `${BASE}/search`, String(err?.message || err));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const query = searchText(keyword);
  const sourceUrl = `${BASE}/search?q=${encodeURIComponent(query)}`;
  const apiUrl = `${BASE}/api/searchapi/getsuppliers?searchQuery=${encodeURIComponent(query)}&portalId=1`;
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': sourceUrl },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return fail('blocked', sourceUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return fail('http_error', sourceUrl, `HTTP ${res.status}`);
    }

    const text = await res.text();
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      const low = text.slice(0, 2000).toLowerCase();
      if (low.includes('captcha') || low.includes('access denied') || low.includes('verify you are human')) {
        return fail('blocked', sourceUrl, text.slice(0, 300));
      }
      return fail('layout_changed', sourceUrl, text.slice(0, 300));
    }
    if (!Array.isArray(list)) {
      return fail('layout_changed', sourceUrl, text.slice(0, 300));
    }

    const want = coreName(keyword);
    const matches = list.filter((item) => item && typeof item.Title === 'string' && coreName(item.Title) === want);

    if (matches.length === 0) {
      const top = list.slice(0, 5).map((x) => x.Title).filter(Boolean).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `0 supplier names match "${keyword}" (${list.length} results for "${query}"${top ? ': ' + top : ''})`,
      };
    }

    const records = matches.map((item) => ({
      name: cleanText(item.Title),
      address: cleanText(item.Address),
      postal_address: cleanText(item.PostalAddress),
      keywords: cleanText(item.Keywords),
      profile_url: item.Url ? new URL(item.Url, BASE).href : '',
      supplier_id: item.ID != null ? String(item.ID) : '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url || sourceUrl,
      excerpt: `${records[0].name} | ${records[0].address}`.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', sourceUrl, String(err?.message || err));
  }
}
