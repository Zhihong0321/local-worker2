export const meta = {
  task: 'KR-mt.co.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'code', 'industry', 'price', 'price_date'],
  canary: { found: '삼성전자', not_found: '가나다라마바사' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const LEGAL_KO = /주식회사|유한책임회사|유한회사|합자회사|합명회사|\(주\)|\(유\)/g;
const LEGAL_EN = /\b(co\.?\s*,?\s*ltd\.?|ltd\.?|inc\.?|corp\.?|corporation|limited|llc)\b/gi;

// Removes the legal form (주식회사, (주), Co., Ltd. ...) so the site gets the trading name it indexes.
function stripLegal(raw) {
  return String(raw || '').normalize('NFKC').replace(LEGAL_KO, ' ').replace(LEGAL_EN, ' ').replace(/\s+/g, ' ').trim();
}

// Compares names: legal form removed, case, spaces and punctuation ignored.
function normalizeName(raw) {
  return stripLegal(raw).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const query = stripLegal(keyword);
    searchUrl = `https://www.mt.co.kr/api/search/keyword/recommend?keyword=${encodeURIComponent(query)}`;
    if (!query) return fail('other', searchUrl, 'nothing left to search after removing the legal form');

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.mt.co.kr/search',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|access denied/i.test(text)) return fail('blocked', searchUrl, text);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail('layout_changed', searchUrl, text);
    }
    if (!body || body.code !== 0 || !body.data || !Array.isArray(body.data.recommends) || !('stock' in body.data)) {
      return fail('layout_changed', searchUrl, text);
    }

    const stock = body.data.stock;
    if (!stock) {
      // Korean names are indexed in Hangul; a miss on a Latin-only name does not prove the company is absent.
      if (!HANGUL.test(query)) {
        return fail('other', searchUrl, `no listed company matched "${query}"; the site indexes companies by Korean name`);
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `no listed company named "${query}" on MoneyToday` };
    }

    if (normalizeName(stock.name) !== normalizeName(keyword)) {
      return fail('other', searchUrl, `site returned a different listed company for "${query}": ${stock.name} (${stock.code})`);
    }

    return {
      status: 'found',
      reason: '',
      records: [{
        name: stock.name,
        code: stock.code,
        industry: stock.uname || '',
        price: stock.price ?? null,
        price_date: [stock.date, stock.time].filter(Boolean).join(' '),
      }],
      source_url: searchUrl,
      excerpt: `${stock.name} (${stock.code}), ${stock.uname || ''}, price ${stock.price ?? ''} (${stock.stockdate || ''})`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
