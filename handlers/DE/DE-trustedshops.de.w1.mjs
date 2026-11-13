export const meta = {
  task: 'DE-trustedshops.de',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'shop_name', 'ts_id', 'profile_type', 'profile_url', 'shop_url', 'average_rating', 'review_count', 'certification_state', 'contract_start_date', 'categories'],
  canary: { found: 'Zalando SE', not_found: 'Nichtexistierende Phantasie Firma GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://shop-search-api.trustedshops.com/shopsearch';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// Legal-form words, compared after transliteration and lower-casing.
const LEGAL_FORMS = new Set(['gmbh', 'mbh', 'ag', 'se', 'kg', 'ohg', 'gbr', 'co', 'ug', 'ev', 'eg', 'ltd', 'limited',
  'llc', 'inc', 'corp', 'bv', 'nv', 'sl', 'srl', 'sa', 'sas', 'sarl', 'ab', 'as', 'oy', 'kft', 'spa', 'sro', 'sdn',
  'bhd', 'pte', 'pvt', 'plc', 'lp', 'llp', 'ltda']);

class Check extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

function translit(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Normalised company key: letters and digits only, legal-form words removed. */
function coreKey(s) {
  return translit(s).split(/[^a-z0-9]+/).filter((t) => t && !LEGAL_FORMS.has(t)).join('');
}

/** Search words as typed, minus legal-form words and punctuation (the search returns nothing when given '&' or '.'). */
function searchTerm(s) {
  return String(s || '')
    .replace(/[-\/]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w && !LEGAL_FORMS.has(translit(w)))
    .join(' ');
}

async function fetchPage(term, page) {
  const url = `${API}?searchTerm=${encodeURIComponent(term)}&pageSize=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) throw new Check('blocked', `HTTP ${res.status}`);
  if (!res.ok) throw new Check('http_error', `HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (/captcha|challenge|access denied/i.test(text)) throw new Check('blocked', 'bot check page');
    throw new Check('layout_changed', 'search response is not JSON');
  }
  if (!data || !Array.isArray(data.shops) || !data.metaData) {
    throw new Check('layout_changed', 'search response has no shops list');
  }
  return { url, data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node on Windows aborts (exit 127, libuv assertion) when the process exits straight after this host's
  // connection was used. A short pause lets the socket close first; the answer itself is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const input = String(keyword ?? '').trim();
  const term = searchTerm(input);
  const key = coreKey(input);
  if (!term || !key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no usable words in the company name' };
  }

  try {
    // The search API counts pages from 0.
    const first = await fetchPage(term, 0);
    const rawPages = Number(first.data.metaData?.totalPageCount) || 1;
    const totalPages = Math.min(rawPages, MAX_PAGES);
    const pages = [first];
    const matches = [];
    const seen = new Set();
    const collect = (page) => {
      for (const s of page.data.shops) {
        if (coreKey(s.accountName) === key && !seen.has(s.tsID)) {
          seen.add(s.tsID);
          matches.push({ page, s });
        }
      }
    };
    collect(first);

    // Not on page 1: read the remaining pages of the same search (a fuzzy search can rank the company lower).
    if (matches.length === 0 && totalPages > 1) {
      const rest = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(term, i + 1)),
      );
      for (const p of rest) { pages.push(p); collect(p); }
    }

    if (matches.length > 0) {
      const records = matches.map(({ s }) => ({
        name: s.accountName || '',
        shop_name: s.shopName || '',
        ts_id: s.tsID || '',
        profile_type: s.profileType || '',
        profile_url: s.profileUrl ? 'https://' + String(s.profileUrl).replace(/^https?:\/\//, '') : '',
        shop_url: s.shopUrl || '',
        average_rating: s.averageRating ?? null,
        review_count: s.reviewCount ?? null,
        certification_state: s.certificationState ?? '',
        contract_start_date: s.contractStartDate ?? '',
        categories: (s.shopCategories || []).map((c) => c.name),
      }));
      const first1 = matches[0].s;
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matches[0].page.url,
        excerpt: `${first1.accountName} | ${first1.shopUrl || ''} | rating ${first1.averageRating} from ${first1.reviewCount} reviews`,
      };
    }

    if (rawPages > MAX_PAGES) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: first.url,
        excerpt: `search returned ${first.data.metaData?.totalShopCount} shops; only the first ${MAX_PAGES} pages were read`,
      };
    }

    const scanned = pages.reduce((n, p) => n + p.data.shops.length, 0);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: first.url,
      excerpt: `Trusted Shops search for "${term}": ${first.data.metaData?.totalShopCount ?? 0} shops, none named like "${input}" (${scanned} read)`,
    };
  } catch (err) {
    if (err instanceof Check) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: API, excerpt: err.message };
    }
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: API,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
