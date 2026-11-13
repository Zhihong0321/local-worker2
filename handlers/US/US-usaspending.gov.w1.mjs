export const meta = {
  task: 'US-usaspending.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'uei', 'duns', 'recipient_level', 'amount', 'id', 'profile_url'],
  canary: { found: 'LOCKHEED MARTIN CORPORATION', not_found: 'Xqzvbrt Nonexistent Holdings LLC' },
};

// USAspending public JSON API: POST recipient search (the same call the site's recipient search makes).
const API_URL = 'https://api.usaspending.gov/api/v2/recipient/';
const SITE_SEARCH_URL = 'https://www.usaspending.gov/search/?keyword=';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 4;          // at most 400 results are read per lookup
const NO_NEW_PAGE_AFTER_MS = 30000; // keeps the whole call well under 60 s

// Legal-form words dropped from the END of a name before comparing (so "ACME CORP" = "Acme Corporation").
const LEGAL_FORMS = new Set([
  'corporation', 'corp', 'incorporated', 'inc', 'company', 'co', 'llc', 'limited', 'ltd',
  'lp', 'llp', 'plc', 'pllc', 'pc', 'pa', 'gmbh', 'sa', 'ag', 'nv', 'bv', 'srl', 'pty', 'bhd', 'sdn',
]);

/** Name -> lower-case words without punctuation and without trailing legal-form words. */
function nameWords(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words;
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const words = nameWords(keyword);
    if (words.length === 0) return fail('other', SITE_SEARCH_URL, 'empty company name');

    const searchText = words.join(' ');
    const wanted = words.join('');
    const sourceUrl = SITE_SEARCH_URL + encodeURIComponent(searchText);

    const matches = [];
    let total = null;
    let complete = false; // true only when every page of results was read

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) break;

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ keyword: searchText, limit: PAGE_SIZE, page, order: 'desc', sort: 'amount' }),
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return fail('blocked', sourceUrl, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return fail('http_error', sourceUrl, `HTTP ${res.status}`);
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return fail('layout_changed', sourceUrl, text.slice(0, 200));
      }
      if (!data || !Array.isArray(data.results) || !data.page_metadata) {
        return fail('layout_changed', sourceUrl, text.slice(0, 200));
      }

      total = data.page_metadata.total;
      for (const r of data.results) {
        if (!r || typeof r.name !== 'string') continue;
        if (nameWords(r.name).join('') !== wanted) continue;
        matches.push({
          name: r.name,
          uei: r.uei ?? null,
          duns: r.duns ?? null,
          recipient_level: r.recipient_level ?? null,
          amount: r.amount ?? null,
          id: r.id ?? null,
          profile_url: r.id ? `https://www.usaspending.gov/recipient/${r.id}` : null,
        });
      }

      if (!data.page_metadata.hasNext) {
        complete = true;
        break;
      }
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: `${matches.length} recipient record(s) with the same name; site total for "${searchText}": ${total}`,
      };
    }
    if (complete) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `0 recipients with this name among ${total} results for "${searchText}"`,
      };
    }
    return fail('other', sourceUrl, `no exact name match in the first pages of ${total} results for "${searchText}"`);
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, SITE_SEARCH_URL, String(err?.message || err));
  }
}
