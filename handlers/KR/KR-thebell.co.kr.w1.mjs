export const meta = {
  task: 'KR-thebell.co.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'thebell_company_id', 'news_url'],
  canary: { found: '삼성전자', not_found: '가나다라마바사아자차카타파하' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.thebell.co.kr';

// Korean and English legal forms, removed before comparing names.
const LEGAL_FORM = /(주식회사|유한책임회사|유한회사|합자회사|합명회사|사단법인|재단법인|\(주\)|\(유\)|\(합자\)|\(합명\)|㈜|㈒|\bco\.?\s*,?\s*ltd\.?|\bltd\.?|\binc\.?|\bcorp\.?|\bllc\b|\blimited\b|\bcompany\b)/giu;

/** Name without legal form, spaces or punctuation, lower case. Used only for comparing. */
function core(s) {
  return (s || '').replace(LEGAL_FORM, ' ').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** The search text sent to the site: legal form removed, spaces removed, punctuation kept. */
function queryText(s) {
  return (s || '').replace(LEGAL_FORM, ' ').replace(/\s+/g, '').trim();
}

function headers(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': referer,
  };
}

function failure(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchPage = `${BASE}/search/search.asp`;
  let sourceUrl = searchPage;
  try {
    const wanted = core(keyword);
    if (wanted.length < 2) {
      return failure('other', searchPage, 'name is shorter than 2 characters after removing the legal form; the site search needs 2');
    }

    const q = queryText(keyword);
    const acUrl = `${BASE}/search/autocom.asp?q=${encodeURIComponent(q)}`;
    sourceUrl = acUrl;

    // Step 1: the site's company-name lookup (the same request its search box makes).
    const res = await fetch(acUrl, { headers: headers(searchPage), signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return failure('blocked', acUrl, `HTTP ${res.status}`);
    if (!res.ok) return failure('http_error', acUrl, `HTTP ${res.status}`);

    const text = await res.text();

    // The site answers "no company entries" with an empty 200 body (checked on the site for nonsense names;
    // the normal news search page for the same names shows "총 0개"). Refusals come as 403/429 or HTML, handled above.
    if (text.trim() === '') {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: acUrl,
        excerpt: `The site returned no company entries for "${q}".`,
      };
    }

    // Anything else must be the JSON list the site's search box reads.
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const low = text.toLowerCase();
      const blockedHint = /captcha|access denied|forbidden|접근이 제한|차단/.test(low);
      return failure(blockedHint ? 'blocked' : 'layout_changed', acUrl, text.replace(/\s+/g, ' ').slice(0, 300));
    }
    if (!data || !Array.isArray(data.list)) {
      return failure('layout_changed', acUrl, text.slice(0, 300));
    }

    // Step 2: keep only entries whose normalised name equals the company's normalised name.
    const matches = data.list.filter((item) => item && typeof item.name === 'string' && core(item.name) === wanted);
    const records = matches.map((item) => ({
      name: item.name,
      thebell_company_id: String(item.value),
      news_url: `${BASE}/front/newslistShort.asp?com_cd=${encodeURIComponent(String(item.value))}&keyword=${encodeURIComponent(item.name)}`,
    }));

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: acUrl,
        excerpt: `${data.list.length} company entries returned for "${q}", none with the same name.`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].news_url,
      excerpt: `${records.length} company entr${records.length === 1 ? 'y' : 'ies'} with the same name: ${records.map((r) => `${r.name} (${r.thebell_company_id})`).join(', ')}`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'TimeoutError' || name === 'AbortError') return failure('timeout', sourceUrl, String(err?.message || err));
    return failure('other', sourceUrl, String(err?.message || err));
  }
}
