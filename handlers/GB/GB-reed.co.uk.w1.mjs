export const meta = {
  task: 'GB-reed.co.uk',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'profile_id', 'job_count'],
  canary: { found: 'Costa Coffee', not_found: 'Zyqorvex Holdings Ltd' },
};

const BASE = 'https://www.reed.co.uk';
const SEARCH_PATH = '/recruiterdirectory';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;
const MORE_PAGES_TIME_LIMIT_MS = 35000; // do not start page 2 or 3 after this, so the call finishes under 60 s

// Legal-form words that the site's search does not accept (a keyword with "Ltd" returns 0 results).
const LEGAL_FORM_TAIL = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'lp', 'inc', 'incorporated', 'corp', 'corporation', 'cic']);

/** Words of the name as typed, legal form removed from the end (case kept, used as the search keyword). */
function searchWords(name) {
  const words = String(name || '').replace(/&/g, ' and ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (words.length > 1 && LEGAL_FORM_TAIL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words;
}

/** Normalised comparison key: accents, case, punctuation, spaces and legal form removed. */
function matchKey(name) {
  const plain = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ');
  const words = plain.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (words.length > 1 && LEGAL_FORM_TAIL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** One card per listed company: the anchor's title reads "<n> jobs from <company name>". */
function parseCards(html) {
  const cards = [];
  const anchors = html.match(/<a\b[^>]*class="subtitle-text"[^>]*>/g) || [];
  for (const tag of anchors) {
    const href = (tag.match(/\bhref="([^"]+)"/) || [])[1];
    const title = decodeEntities((tag.match(/\btitle="([^"]*)"/) || [])[1] || '');
    const m = title.match(/^([\d,]+) jobs? from (.+)$/);
    if (!href || !m) continue;
    const id = (href.match(/\/p(\d+)(?:[?#]|$)/) || [])[1] || '';
    cards.push({
      name: m[2].trim(),
      profile_url: new URL(href, BASE).href.split('?')[0],
      profile_id: id,
      job_count: Number(m[1].replace(/,/g, '')),
    });
  }
  return cards;
}

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const words = searchWords(keyword);
    if (words.length === 0) return fail('other', '', 'empty company name');
    const term = words.join(' ');
    const key = matchKey(keyword);
    const pageUrl = (page) => `${BASE}${SEARCH_PATH}?keywords=${encodeURIComponent(term)}${page > 1 ? `&pageno=${page}` : ''}`;

    const matches = [];
    let morePages = false;
    let lastUrl = pageUrl(1);

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > MORE_PAGES_TIME_LIMIT_MS) { morePages = true; break; }
      const url = pageUrl(page);
      lastUrl = url;

      let res;
      try {
        res = await fetch(url, {
          headers: {
            'user-agent': USER_AGENT,
            'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-GB,en;q=0.9',
          },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        if (page > 1 && matches.length) break; // keep what page 1 already showed
        return fail(isTimeout(err) ? 'timeout' : 'other', url, err?.message || err);
      }

      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      let html;
      try {
        html = await res.text();
      } catch (err) {
        return fail(isTimeout(err) ? 'timeout' : 'other', url, err?.message || err);
      }

      const isResultsPage = html.includes('mainSearchCompany') && html.includes('recruiter-dirtectory-main-content-logos');
      if (!isResultsPage) {
        if (/Just a moment|cf-chl|captcha|Access denied/i.test(html)) return fail('blocked', url, 'bot check page');
        return fail('layout_changed', url, html.slice(0, 200));
      }

      const cards = parseCards(html);
      if (cards.length === 0 && page === 1) {
        // A real empty result says result:0 in the page. Anything else is a page we do not understand.
        if (!html.includes('result:0')) return fail('layout_changed', url, 'no company cards and no result:0 marker');
        return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `Reed recruiter directory: 0 companies for "${term}"` };
      }

      for (const c of cards) {
        if (matchKey(c.name) === key) matches.push(c);
      }

      morePages = html.includes('gtmPaginationNext');
      if (!morePages) break;
    }

    // Keep one record per listing (the same company can have several profile pages).
    const seen = new Set();
    const records = matches.filter((r) => (seen.has(r.profile_id || r.profile_url) ? false : seen.add(r.profile_id || r.profile_url)));

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: lastUrl,
        excerpt: `Reed recruiter directory lists "${records[0].name}" (${records.length} profile${records.length > 1 ? 's' : ''}), ${records.map((r) => r.job_count).join(', ')} jobs`,
      };
    }

    if (morePages) {
      return fail('other', lastUrl, `"${term}" has more result pages than were read; match not seen in the first ${MAX_PAGES} pages`);
    }

    return { status: 'not_found', reason: '', records: [], source_url: lastUrl, excerpt: `Reed recruiter directory: no company named "${keyword}" for "${term}"` };
  } catch (err) {
    return fail(isTimeout(err) ? 'timeout' : 'other', `${BASE}${SEARCH_PATH}`, err?.message || err);
  }
}
