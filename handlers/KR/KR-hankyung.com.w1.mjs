export const meta = {
  task: 'KR-hankyung.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'code', 'market', 'english_name', 'url'],
  canary: { found: '삼성전자', not_found: '가나다라마바사아자차카타' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://api-www.hankyung.com/search/finance/list?keyword=';
const SITE = 'https://markets.hankyung.com';

// Legal-form words, removed from the typed name before the search and before the match (Korean and English).
const LEGAL_FORMS = /주식회사|유한책임회사|유한회사|합자회사|\(주\)|\(유\)|㈜|co\.?\s*,?\s*ltd\.?|pte\.?\s*ltd\.?|sdn\.?\s*bhd\.?|\binc\.?|\bcorp(oration)?\.?|\bllc\b|\bplc\b|\blimited\b|\bltd\.?/gi;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

function coreName(keyword) {
  return String(keyword || '').replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();
}

function normalise(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const q = coreName(keyword);
    if (!q) return fail('other', '', 'empty company name');
    searchUrl = API + encodeURIComponent(q);

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Referer': `${SITE}/stock/list`,
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body) {
      const challenge = /Just a moment|cf-chl|challenge-platform/i.test(text);
      return fail(challenge ? 'blocked' : 'layout_changed', searchUrl, text.slice(0, 300));
    }
    if (body.code !== 200 || !body.data || !Array.isArray(body.data.list)) {
      return fail('layout_changed', searchUrl, text.slice(0, 300));
    }

    const list = body.data.list;
    const key = normalise(q);
    // An exact name match on the Korean name, or on the English name (ename), is the same company.
    const matches = list.filter((i) => normalise(i.name) === key || normalise(i.ename) === key);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((i) => ({
          name: i.name,
          code: i.code,
          market: i.market,
          english_name: i.ename || '',
          url: i.url || `${SITE}/stock/${i.code}`,
        })),
        source_url: matches[0].url || searchUrl,
        excerpt: matches.map((i) => `${i.name} (${i.code}, ${i.market})`).join('; ').slice(0, 300),
      };
    }

    // The search ranks exact Korean names first. It is not trusted for English names, so no not_found here.
    if (!HANGUL.test(q)) {
      return fail('other', searchUrl, `no exact match among ${list.length} results; the search is not trusted for English names`);
    }
    // A long list with no exact name may be cut off before the company appears, so that is not proof of absence.
    if (list.length >= 15) {
      return fail('other', searchUrl, `${list.length} results and none has this exact name; the list may be cut off`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: list.length ? `${list.length} similar listings, none with this exact name` : 'search returned 0 results',
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
