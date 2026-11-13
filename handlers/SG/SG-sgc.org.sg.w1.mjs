export const meta = {
  task: 'SG-sgc.org.sg',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'country', 'website', 'detail_url'],
  canary: { found: 'Ammerland Asia Pacific Pte Ltd', not_found: '新加坡宏远贸易有限公司' },
};

const BASE = 'https://www.sgc.org.sg';
const LIST_PATH = '/en/membership/members-listing';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 2; // 2 fetches x 25 s stays under the 60 s limit
// Legal-form words, dropped before comparing names and before searching.
const LEGAL = new Set(['pte', 'pvt', 'private', 'ltd', 'limited', 'sdn', 'bhd', 'berhad', 'llp', 'llc', 'inc',
  'incorporated', 'gmbh', 'kg', 'ag', 'se', 'co', 'corp', 'corporation', 'company', 'plc']);

/** Lower-case words of a name (letters and digits of any script), '&' read as 'and'. */
function words(s) {
  return (s || '').replace(/&amp;|&/g, ' and ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Comparison key: the name's words without the legal form. */
function nameKey(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join(' ');
}

/** The search text: the name as typed, minus the legal-form words (the site's search fails on "Pte Ltd" etc.). */
function searchTerm(input) {
  const kept = input.split(/\s+/).filter((t) => t && !LEGAL.has(words(t).join('')));
  return kept.join(' ').trim() || input;
}

function decode(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#0*39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** One object per member row of a directory results page. */
function parseRows(html) {
  const rows = [];
  const re = /<tr class="members-list-row"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const r = m[1];
    const nameM = r.match(/<span class="d-block fw-semibold">([\s\S]*?)<\/span>/);
    if (!nameM) continue;
    const detailM = r.match(/href="(\/en\/membership\/members-listing\/[^"]+)"\s+class="members-list-link-to-member/);
    const webM = r.match(/href="([^"]+)"\s+class="members-list-link-to-company/);
    const countryM = r.match(/<td class="members-list-cell is-cell-country[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    rows.push({
      name: decode(nameM[1]),
      country: countryM ? decode(countryM[1]) : '',
      website: webM ? new URL(webM[1], BASE).href : '',
      detail_url: detailM ? new URL(detailM[1], BASE).href : '',
    });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // On Windows / Node 24 the runner's process.exit() can hit a socket that is still closing and abort (exit 127)
  // after the answer is printed. A short pause lets the connections close first.
  await new Promise((done) => setTimeout(done, 500));
  return answer;
}

async function run(keyword) {
  const input = String(keyword || '').trim();
  const term = input ? searchTerm(input) : '';
  const firstUrl = `${BASE}${LIST_PATH}?members_directory_filter%5BsearchTerm%5D=${encodeURIComponent(term)}`;
  const cc = (reason, excerpt, src = firstUrl) =>
    ({ status: 'couldnt_check', reason, records: [], source_url: src, excerpt: String(excerpt).slice(0, 500) });

  try {
    const wanted = nameKey(input);
    if (!wanted) return cc('other', 'no company name in the keyword');

    const get = (url) => fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    const matches = [];
    const seenNames = [];
    let noResultsPage = false;
    let page = 1;
    let url = firstUrl;
    for (;;) {
      const res = await get(url);
      if (res.status === 403 || res.status === 429) return cc('blocked', `HTTP ${res.status}`);
      if (!res.ok) return cc('http_error', `HTTP ${res.status}`);
      const html = await res.text();

      const noResults = html.includes('No results for:');
      const hasResults = html.includes('Results for:');
      if (!noResults && !hasResults) {
        if (/captcha|access denied|are you a robot/i.test(html)) return cc('blocked', 'bot or block page');
        return cc('layout_changed', html.slice(0, 200), url);
      }
      if (noResults && page === 1) noResultsPage = true;

      const rows = parseRows(html);
      if (hasResults && rows.length === 0) return cc('layout_changed', 'results text present but no member rows', url);
      for (const row of rows) {
        seenNames.push(row.name);
        if (nameKey(row.name) === wanted) matches.push(row);
      }
      if (matches.length) break;

      const hasNext = new RegExp(`page%5D=${page + 1}(?!\\d)`).test(html);
      if (!hasNext) break;
      if (page >= MAX_PAGES) return cc('other', `no match on pages 1-${page}; more result pages were not checked`, url);
      page += 1;
      url = `${firstUrl}&members_directory_filter%5Bpage%5D=${page}`;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `Results for: ${term}. Matched: ${matches.map((m) => m.name).join('; ')}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: noResultsPage
        ? `No results for: ${term}`
        : `Results for: ${term}; none has the same name. Listed: ${seenNames.slice(0, 10).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
