export const meta = {
  task: 'NL-dnb.nl',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['statutory_name', 'relation_number', 'chamber_of_commerce', 'statutory_seat', 'statutory_country', 'lei_code', 'register_name', 'register_code', 'classifications', 'trade_names', 'url'],
  canary: { found: 'ING Bank N.V.', not_found: 'Zwarte Kat Verzinsel Beheer B.V.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://www.dnb.nl';
const PAGE_URL = `${BASE}/openbaar-register/?l=10&p=1`;
const API_URL = `${BASE}/api/publicregister/search`;
const LIMIT = '50';
const MAX_PAGES = 3;
const SOFT_DEADLINE_MS = 30000; // no new request after 30 s, so the whole call stays under 60 s
// Legal forms are dropped from the end of a name on both sides before comparing.
const LEGAL_FORM_SUFFIXES = ['nv', 'bv', 'vof', 'cv', 'coop'];

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normName(s) {
  let n = decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const suffix of LEGAL_FORM_SUFFIXES) {
    if (n.length > suffix.length && n.endsWith(suffix)) {
      n = n.slice(0, -suffix.length);
      break;
    }
  }
  return n;
}

function cc(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 500) };
}

function toRecord(row) {
  return {
    statutory_name: decode(row.statutoryName),
    relation_number: row.relationNumber || '',
    chamber_of_commerce: row.chamberOfCommerce || '',
    statutory_seat: decode(row.statutorySeat),
    statutory_country: decode(row.statutoryCountry),
    lei_code: row.leiCode || '',
    register_name: decode(row.registerName),
    register_code: row.registerCode || '',
    classifications: decode(row.classifications),
    trade_names: decode(row.tradeNames),
    url: row.url ? new URL(row.url, BASE).href : '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword ?? '').trim();
  try {
    const kwNorm = normName(kw);
    if (!kwNorm) return cc('other', PAGE_URL, 'empty company name');

    // Step 1: the register page carries the search identifier the search API needs.
    const pageRes = await fetch(PAGE_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    const pageText = await pageRes.text();
    if (pageRes.status === 403 || pageRes.status === 429 || /Access Denied|captcha/i.test(pageText.slice(0, 5000))) {
      return cc('blocked', PAGE_URL, `HTTP ${pageRes.status} on the register page`);
    }
    if (!pageRes.ok) return cc('http_error', PAGE_URL, `HTTP ${pageRes.status} on the register page`);
    const idMatch = pageText.match(/<auto-suggest[^>]*\sidentifier="([A-Za-z0-9_-]{16,})"/i);
    if (!idMatch) return cc('layout_changed', PAGE_URL, 'no search identifier found on the register page');
    const identifier = idMatch[1];

    // Step 2: the register search API, one request per result page.
    const matches = [];
    let resultCount = 0;
    let pageNo = 1;
    let totalPages = 1;
    while (pageNo <= totalPages && pageNo <= MAX_PAGES) {
      if (Date.now() - started > SOFT_DEADLINE_MS) {
        return matches.length
          ? foundResult(kw, matches, resultCount)
          : cc('timeout', PAGE_URL, `time limit reached after ${pageNo - 1} result page(s) for "${kw}"`);
      }
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
          Origin: BASE,
          Referer: PAGE_URL,
        },
        body: JSON.stringify({ identifier, language: 'nl', page: String(pageNo), limit: LIMIT, phrase: kw, filterData: {}, sortBy: '' }),
        signal: AbortSignal.timeout(25000),
      });
      const text = await res.text();
      if (res.status === 403 || res.status === 429 || /Access Denied|captcha/i.test(text.slice(0, 2000))) {
        return cc('blocked', API_URL, `HTTP ${res.status} from the register search`);
      }
      if (!res.ok) return cc('http_error', API_URL, `HTTP ${res.status} from the register search`);

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return cc('layout_changed', API_URL, text.slice(0, 300));
      }
      if (!data || !Array.isArray(data.resultData) || typeof data.resultCount !== 'number' || !data.pager) {
        return cc('layout_changed', API_URL, text.slice(0, 300));
      }
      if (Array.isArray(data.errors) && data.errors.length) {
        return cc('other', API_URL, 'register search returned errors: ' + JSON.stringify(data.errors).slice(0, 300));
      }

      resultCount = data.resultCount;
      totalPages = Number(data.pager.totalPages) || 0;
      for (const row of data.resultData) {
        // Exact match on the statutory (legal) name, or on one of the registered trade names.
        const byLegalName = normName(row.statutoryName) === kwNorm;
        const byTradeName = decode(row.tradeNames).split(', ').some((t) => normName(t) === kwNorm);
        if (byLegalName || byTradeName) matches.push(toRecord(row));
      }
      pageNo++;
    }

    if (matches.length) return foundResult(kw, matches, resultCount);

    // Nothing matched. "Not found" is only honest if every result page was read.
    if (pageNo <= totalPages) {
      return cc('other', PAGE_URL, `${resultCount} register entries for "${kw}"; only the first ${MAX_PAGES} pages were checked`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `DNB register search for "${kw}" returned ${resultCount} entries, none with this statutory name`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timedOut ? 'timeout' : 'other', PAGE_URL, String(err?.message || err));
  }
}

function foundResult(kw, matches, resultCount) {
  return {
    status: 'found',
    reason: '',
    records: matches,
    source_url: PAGE_URL,
    excerpt: `DNB register: ${matches.length} entr${matches.length === 1 ? 'y' : 'ies'} matching "${kw}" (statutory name "${matches[0].statutory_name}"; ${resultCount} results in total)`,
  };
}
