export const meta = { task: 'TW-cnyes.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'short_name', 'english_name', 'symbol', 'code', 'market', 'stock_type', 'industry', 'address', 'phone'],
  canary: { found: '台灣積體電路製造股份有限公司', not_found: '不存在的公司甲乙丙' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed from the end of a normalised name (longest first).
const LEGAL_SUFFIXES = ['股份有限公司', '有限責任公司', '有限公司', '股份有限', '公司',
  'coltd', 'incorporated', 'limited', 'ltd', 'inc', 'corporation', 'corp', 'company', 'co'];

/** Lower-case, full-width folded, no spaces or punctuation, no legal form. */
function norm(s) {
  let t = String(s || '').replace(/<[^>]*>/g, '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (t.length > suf.length && t.endsWith(suf)) { t = t.slice(0, -suf.length); changed = true; }
    }
  }
  return t;
}

function clean(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Read the company profile that the stock page embeds as JSON. Returns {} if it cannot be read. */
async function readProfile(code) {
  const pageUrl = `https://www.cnyes.com/twstock/${encodeURIComponent(code)}`;
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { pageUrl, profile: {} };
    const html = await res.text();
    const m = html.match(/"companyProfile":(\{(?:[^{}"]|"(?:[^"\\]|\\.)*")*\})/);
    if (!m) return { pageUrl, profile: {} };
    return { pageUrl, profile: JSON.parse(m[1]) || {} };
  } catch {
    return { pageUrl, profile: {} };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows can abort on exit while a fetch socket is still closing (exit code 127, after the answer
  // is printed). A short pause before returning lets the sockets close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const kwRaw = String(keyword || '').trim();
  const searchUrl = `https://ess.api.cnyes.com/ess/api/v1/siteSearch/main?category=TW&limit=10&q=${encodeURIComponent(kwRaw)}`;
  if (!kwRaw) return failure('other', searchUrl, 'empty company name');

  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://www.cnyes.com/search/' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return failure('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return failure('http_error', searchUrl, `HTTP ${res.status}`);

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return failure('layout_changed', searchUrl, text); }
    if (!json || json.statusCode !== 200 || !json.data || !Array.isArray(json.data.quoteFunds)) {
      return failure('layout_changed', searchUrl, text);
    }

    // Taiwan listed stocks only (symbol like TWS:2330:STOCK). Funds, news and drivers are not companies.
    const stocks = json.data.quoteFunds.filter((q) => q && q.mtype === 'STOCK' && String(q.symbol || '').startsWith('TW'));
    const kw = norm(kwRaw);
    const matches = stocks.filter((q) =>
      kw && [q.chName, q.chNameFull, q.enName, q.enNameFull].map(norm).includes(kw));

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 matching Taiwan stock records for "${kwRaw}" (${stocks.length} stock results, none with this name)`,
      };
    }

    const records = [];
    let pageUrl = searchUrl;
    for (const q of matches) {
      const got = await readProfile(q.code);
      const p = got.profile || {};
      pageUrl = got.pageUrl;
      records.push({
        name: clean(q.chNameFull) || p.companyName || '',
        short_name: clean(q.chName),
        english_name: clean(q.enNameFull) || p.companyEnglishName || '',
        symbol: q.symbol || '',
        code: q.code || '',
        market: q.exchange || '',
        stock_type: p.stockType || '',
        industry: clean(q.industry) || p.industryType || '',
        address: p.companyAddress || '',
        phone: p.telephoneNumber || '',
      });
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt: `${first.name} (${first.symbol}) ${first.stock_type} ${first.industry}`.trim().slice(0, 300),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
