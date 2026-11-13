export const meta = {
  task: 'KR-innoforest.co.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'corp_id', 'name_en', 'intro', 'product', 'business_areas', 'tags', 'revenue_krw', 'investment_total', 'employees', 'hiring', 'page_url'],
  canary: { found: '럭스로보', not_found: '쿠라즈마헤이카이주식회사' },
};

const API = 'https://liveapi.innoforest.co.kr/seed/search/v1/findcorp';
const SITE = 'https://www.innoforest.co.kr';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const PAGING_DEADLINE_MS = 30000; // stop reading more pages after 30 s, so the whole call stays under 60 s

// Korean and English legal-form words, removed before comparing names.
const KR_LEGAL = /(주식회사|유한회사|합자회사|합명회사|유한책임회사|사단법인|재단법인|\(주\)|\(유\)|㈜|㈑)/g;
const EN_LEGAL = /(?<![a-z])(co\.?\s*,?\s*ltd\.?|company|corporation|corp\.?|inc\.?|llc|limited|ltd\.?)(?![a-z])/gi;

function stripLegal(s) {
  return String(s || '').replace(KR_LEGAL, ' ').replace(EN_LEGAL, ' ');
}

function norm(s) {
  return stripLegal(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function toRecord(r) {
  return {
    corp_id: r.corpId ?? '',
    name: r.corpNameKr ?? '',
    name_en: r.corpNameEn ?? '',
    intro: r.corpIntroKr ?? '',
    product: r.prodNameKr ?? '',
    business_areas: r.bizNamesKr ?? '',
    tags: r.tagNamesKr ?? '',
    revenue_krw: r.finacRevenueVal ?? null,
    investment_total: r.invstSumValText ?? '',
    employees: r.empWholeVal ?? null,
    hiring: r.hiring ?? null,
    page_url: `${SITE}/company/${r.corpId}/${encodeURIComponent(r.corpNameKr || '')}`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const raw = String(keyword ?? '').trim();
  const q = stripLegal(raw).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const nk = norm(raw);
  const firstUrl = `${API}?keyword=${encodeURIComponent(q)}&page=1&size=${PAGE_SIZE}`;
  if (!q || !nk) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'keyword has no searchable text' };
  }

  try {
    const started = Date.now();
    const all = [];
    let total = null;
    let done = false;
    let stoppedByDeadline = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > PAGING_DEADLINE_MS) { stoppedByDeadline = true; break; }
      const url = `${API}?keyword=${encodeURIComponent(q)}&page=${page}&size=${PAGE_SIZE}`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!json || json.success !== true || !Array.isArray(json.data)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 300) };
      }
      total = json.totalDataCount ?? total;
      all.push(...json.data);
      if (!json.hasNextPage || json.data.length === 0) { done = true; break; }
    }

    // Match the company, not similar words: normalised Korean or English display name must be equal.
    const matches = all.filter((r) => norm(r.corpNameKr) === nk || norm(r.corpNameEn) === nk);

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(toRecord),
        source_url: firstUrl,
        excerpt: `${matches.length} match(es) for "${raw}" among ${total} search results: ${matches.map((m) => m.corpNameKr).join(', ')}`.slice(0, 500),
      };
    }

    if (!done) {
      return {
        status: 'couldnt_check',
        reason: stoppedByDeadline ? 'timeout' : 'other',
        records: [],
        source_url: firstUrl,
        excerpt: `read ${all.length} of ${total} search results without an exact match; the rest were not read`,
      };
    }

    // The site search matches display names (Korean/English brand names) only, not legal names.
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `${total} search result(s) for "${q}", none with this exact display name (the site search does not index legal names)`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: firstUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
