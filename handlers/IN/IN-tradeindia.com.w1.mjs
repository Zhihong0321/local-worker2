export const meta = {
  task: 'IN-tradeindia.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_as_entered', 'profile_id', 'profile_url', 'city', 'state', 'country', 'business_type', 'roles', 'trust_stamp'],
  canary: { found: 'Bhaskar Alloy Castings', not_found: 'Zqxvw Plorenta Nimbora Private Limited' },
};

const SITE = 'https://www.tradeindia.com';
const API = 'https://api.tradeindia.com/search/search/listing';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 30;
const MAX_PAGES = 3;
// Legal-form words that are ignored when comparing names ("Pvt. Ltd." = "Private Limited" = nothing).
const LEGAL = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'opc', 'co', 'company', 'corporation', 'corp', 'inc']);
const ROLE_FLAGS = [
  ['ifmanu', 'manufacturer'], ['ifsupplier', 'supplier'], ['ifexporter', 'exporter'],
  ['ifdistributor', 'distributor'], ['iftrader', 'trader'], ['ifservice', 'service provider'],
];

/** Compare-only key: lower case, no punctuation, no legal form. Empty if nothing is left. */
function nameKey(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !LEGAL.has(t)).join('');
}

/**
 * The term sent to the site: the site's search accepts only [a-zA-Z0-9-+ ] (anything else becomes a space),
 * and it ranks "Name Pvt Ltd" worse than "Name", so the legal-form words are left out of the term.
 */
function searchTerm(s) {
  return String(s || '').replace(/[^A-Za-z0-9+\- ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !LEGAL.has(w.toLowerCase())).join(' ');
}

function fail(reason, excerpt, sourceUrl) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 500) };
}

/** One page of the public search. Returns { data } or { failure } (a couldnt_check answer). */
async function fetchPage(term, page) {
  const url = `${API}?term=${encodeURIComponent(term)}&page=${page}&per_page=${PER_PAGE}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Connection': 'close',
        'Referer': `${SITE}/search.html?keyword=${encodeURIComponent(term)}`,
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { failure: fail(timedOut ? 'timeout' : 'other', String(err?.message || err), url) };
  }
  if (res.status === 403 || res.status === 429) {
    return { failure: fail('blocked', `HTTP ${res.status}`, url) };
  }
  if (!res.ok) {
    return { failure: fail('http_error', `HTTP ${res.status}`, url) };
  }
  // The site answers 204 No Content for a page with no rows (its own front end reads 204 as "no data").
  if (res.status === 204) {
    await res.body?.cancel();
    return { data: { listing_data: [], listing_count: 0, pagination: { total_pages: 0 } }, url };
  }
  const text = await res.text();
  if (/captcha|access denied/i.test(text) && !text.trimStart().startsWith('{')) {
    return { failure: fail('blocked', 'bot or captcha page instead of results', url) };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { failure: fail('layout_changed', text.slice(0, 300), url) };
  }
  if (!data || !Array.isArray(data.listing_data)) {
    return { failure: fail('layout_changed', JSON.stringify(data).slice(0, 300), url) };
  }
  return { data, url };
}

function toRecord(x) {
  const roles = ROLE_FLAGS.filter(([flag]) => x[flag] === true).map(([, label]) => label);
  let profileUrl = '';
  try {
    profileUrl = x.profile_url ? new URL(x.profile_url, SITE).href : '';
  } catch {
    profileUrl = '';
  }
  return {
    name: x.co_name || '',
    name_as_entered: x.initial_co_name || '',
    profile_id: String(x.profile_id ?? ''),
    profile_url: profileUrl,
    city: x.city || '',
    state: x.state || '',
    country: x.country_name || '',
    business_type: x.business_type || '',
    roles,
    trust_stamp: x.has_trust_stamp === true,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const sourceUrl = `${SITE}/search.html?keyword=${encodeURIComponent(input)}`;
  try {
    if (!input) return fail('other', 'empty company name', sourceUrl);
    if (/[^\x00-\x7F]/.test(input)) {
      return fail('other', 'the TradeIndia search accepts only Latin letters, digits, spaces, + and -; this name is written in another script', sourceUrl);
    }
    const term = searchTerm(input);
    const want = nameKey(input);
    if (!term || !want) return fail('other', 'no company name left after removing punctuation and legal form', sourceUrl);

    // Page 1 tells us how many pages exist; pages 2..MAX_PAGES are fetched alongside it.
    const first = await fetchPage(term, 1);
    if (first.failure) return first.failure;
    const totalPages = Number(first.data.pagination?.total_pages) || 1;
    const lastPage = Math.min(totalPages, MAX_PAGES);
    const restPages = [];
    for (let p = 2; p <= lastPage; p++) restPages.push(fetchPage(term, p));
    const rest = await Promise.all(restPages);

    const matches = new Map();
    const pages = [first, ...rest];
    let pageFailure = null;
    for (const page of pages) {
      if (page.failure) { pageFailure = pageFailure || page.failure; continue; }
      for (const x of page.data.listing_data) {
        if (!x || typeof x !== 'object') continue;
        if (nameKey(x.co_name) !== want && nameKey(x.initial_co_name) !== want) continue;
        const rec = toRecord(x);
        const id = rec.profile_id || rec.profile_url;
        if (id && !matches.has(id)) matches.set(id, rec);
      }
    }

    const records = [...matches.values()];
    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: first.url,
        excerpt: records.map((r) => `${r.name} | ${[r.city, r.state].filter(Boolean).join(', ')}`).join(' ; ').slice(0, 500),
      };
    }
    // Nothing matched. Only a complete search may say "not listed".
    if (pageFailure) return { ...pageFailure, source_url: first.url };
    if (totalPages > MAX_PAGES) {
      return fail('other', `no match in the first ${MAX_PAGES} of ${totalPages} result pages (${first.data.listing_count} hits); not all results could be checked`, first.url);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: first.url,
      excerpt: `0 of ${first.data.listing_count ?? first.data.listing_data.length} search hits have the company name "${input}"`,
    };
  } catch (err) {
    return fail('other', String(err?.message || err), sourceUrl);
  }
}
