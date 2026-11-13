export const meta = {
  task: 'TH-set.or.th',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_th', 'symbol', 'market', 'security_type', 'industry', 'sector'],
  canary: { found: 'CP ALL PUBLIC COMPANY LIMITED', not_found: 'บริษัท ทดสอบไม่มีจริง จำกัด (มหาชน)' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 'https://www.set.or.th/en/market/product/stock/search';
const LIST = 'https://www.set.or.th/api/set/stock/list';

/**
 * Compare names on their core words: case, punctuation, Thai/English legal-form words and spacing are ignored.
 * Nothing else is dropped, so two different companies never collapse into one.
 */
function normalize(str) {
  let t = (str || '').normalize('NFC').toLowerCase();
  t = t.replace(/บริษัท|จำกัด|มหาชน/g, ' ');
  t = t.replace(/\bpublic\s+company\s+limited\b|\bpublic\s+co\.?\s*,?\s*ltd\.?|\bcompany\s+limited\b|\bco\.?\s*,?\s*ltd\.?|\bltd\.?|\blimited\b|\bpcl\b|\bplc\b|\bpublic\b|\bcompany\b|\bco\b|\binc\b/g, ' ');
  return t.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The session cookies the public search page sets for every visitor, sent back as a browser would. */
function cookieHeader(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function errReason(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = normalize(keyword);
    if (!want) return failure('other', LIST, 'empty company name');

    // Step 1: the public search page, which sets the session cookies the site's own front end uses.
    const page = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (page.status === 403 || page.status === 429) return failure('blocked', PAGE, `HTTP ${page.status}`);
    if (!page.ok) return failure('http_error', PAGE, `HTTP ${page.status}`);
    const cookie = cookieHeader(page);
    try { await page.body?.cancel(); } catch { /* body not needed */ }

    // Step 2: the listed-securities list the search box filters on.
    const res = await fetch(LIST, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': PAGE,
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return failure('blocked', LIST, `HTTP ${res.status}`);
    if (!res.ok) return failure('http_error', LIST, `HTTP ${res.status}`);

    const text = await res.text();
    if (/Incapsula|Request unsuccessful/i.test(text.slice(0, 2000))) return failure('blocked', LIST, 'bot check page returned');

    let data;
    try { data = JSON.parse(text); } catch { return failure('layout_changed', LIST, text.slice(0, 300)); }
    const list = Array.isArray(data?.securitySymbols) ? data.securitySymbols : null;
    if (!list || list.length === 0) return failure('layout_changed', LIST, 'no securitySymbols list in the response');

    const matches = list.filter((r) => normalize(r.nameEN) === want || normalize(r.nameTH) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST,
        excerpt: `No listed security among ${list.length} on SET/mai matches "${keyword}" after normalising case, punctuation and legal form`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((r) => ({
        name: r.nameEN,
        name_th: r.nameTH,
        symbol: r.symbol,
        market: r.market,
        security_type: r.securityType,
        industry: r.industry,
        sector: r.sector,
      })),
      source_url: LIST,
      excerpt: matches.slice(0, 5).map((r) => `${r.symbol} | ${r.nameEN} | ${r.market} ${r.securityType}`).join(' ; ').slice(0, 300),
    };
  } catch (err) {
    return failure(errReason(err), LIST, String(err?.message || err));
  }
}
