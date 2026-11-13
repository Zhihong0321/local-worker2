export const meta = {
  task: 'GB-cqc.org.uk',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'provider_id', 'entry_type', 'also_known_as', 'address', 'phone', 'location_name', 'url'],
  canary: { found: 'IDH Limited', not_found: 'Zqxvnorlk Health Services Limited' },
};

const SEARCH = 'https://www.cqc.org.uk/search/all';
const SITE = 'https://www.cqc.org.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 10;        // the site lists 10 results per page
const MAX_RESULTS = 100;    // read at most 10 pages for one search word; more than that is not checked
const BUDGET_MS = 30000;    // no new page is started after 30 s, so the whole call ends inside 60 s
const LEGAL = new Set(['limited', 'ltd', 'llp', 'plc', 'lp', 'cic', 'inc', 'incorporated']);

function clean(s) {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower-case words of a name, without accents, punctuation or trailing legal form (Limited, Ltd, PLC...). */
function coreWords(name) {
  const w = (name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

const keyOf = (name) => coreWords(name).join(' ');

function searchUrl(query, page = 1) {
  const p = new URLSearchParams({ query, 'location-query': '', radius: '', display: 'list', sort: 'relevance' });
  if (page > 1) p.set('page', String(page));
  return `${SEARCH}?${p.toString()}`;
}

function parsePage(html) {
  const text = clean(html);
  const m = text.match(/We found ([\d,]+) results?/i);
  const zero = /no results from our site/i.test(text);
  const count = m ? Number(m[1].replace(/,/g, '')) : (zero ? 0 : null);
  const blocks = html.split('<article class="provider-services-list__list-item"').slice(1);
  const entries = [];
  for (const raw of blocks) {
    const body = raw.split('</article>')[0];
    const type = clean((body.match(/data-key="provider\.type">([\s\S]*?)<\/span>/) || [])[1]);
    const title = body.match(/<h2 class="service-header__title">\s*<a href="\s*([^"]*?)\s*">([\s\S]*?)<\/a>/);
    const runBy = body.match(/service-header__provided-by">[\s\S]*?<a href="\s*([^"]*?)\s*">([\s\S]*?)<\/a>/);
    const aka = clean((body.match(/class="aka-name">([\s\S]*?)<\/span>/) || [])[1]);
    const address = clean((body.match(/service-header__contact-info--address">([\s\S]*?)<\/span>/) || [])[1]);
    const phone = clean((body.match(/service-header__contact-info--phone">([\s\S]*?)<\/span>/) || [])[1]);
    if (/^SERVICE PROVIDER$/i.test(type) && title) {
      entries.push({ name: clean(title[2]), href: title[1], entry_type: 'service_provider', also_known_as: aka, address, phone, location_name: '' });
    }
    if (runBy) {
      entries.push({ name: clean(runBy[2]), href: runBy[1], entry_type: 'location_provider', also_known_as: '', address, phone, location_name: title ? clean(title[2]) : '' });
    }
  }
  return { count, articles: blocks.length, entries };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) });
  const stop = (reason, url, excerpt) => { throw Object.assign(new Error(excerpt), { cqc: true, reason, url }); };
  const cache = new Map();

  async function load(query, page) {
    const key = `${query}|${page}`;
    if (cache.has(key)) return cache.get(key);
    if (Date.now() - started > BUDGET_MS) stop('timeout', searchUrl(query, page), 'time budget used up before every page was read');
    const url = searchUrl(query, page);
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) stop('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) stop('http_error', url, `HTTP ${res.status}`);
    const html = await res.text();
    if (/captcha|just a moment|cf-chl|access denied/i.test(html) && !/provider-services-list|We found|no results from our site/i.test(html)) {
      stop('blocked', url, 'bot or captcha page');
    }
    const parsed = parsePage(html);
    if (parsed.count === null) stop('layout_changed', url, clean(html).slice(0, 300));
    cache.set(key, parsed);
    return parsed;
  }

  try {
    const target = keyOf(keyword);
    if (!target) return fail('other', SEARCH, 'no name to search for');

    // The site search is fuzzy (it also matches address text and common words), so search each distinctive
    // word of the name on its own. A word with 0 results means no listed record contains it: not listed.
    const words = [...new Set(coreWords(keyword))].sort((a, b) => b.length - a.length);
    const longWords = words.filter((w) => w.length >= 3).slice(0, 4);
    const use = longWords.length ? longWords : words.slice(0, 1);

    let best = null;
    for (const w of use) {
      const page1 = await load(w, 1);
      if (page1.count === 0) {
        return {
          status: 'not_found', reason: '', records: [], source_url: searchUrl(w),
          excerpt: `CQC search for "${w}" (part of "${keyword}") returned 0 results`,
        };
      }
      if (!best || page1.count < best.count) best = { word: w, count: page1.count };
    }

    if (best.count > MAX_RESULTS) {
      return fail('other', searchUrl(best.word), `${best.count} results for "${best.word}": too many to read every page, so not checked`);
    }

    const pagesNeeded = Math.max(1, Math.ceil(best.count / PER_PAGE));
    const matches = [];
    const seen = new Set();
    for (let p = 1; p <= pagesNeeded; p++) {
      const pg = await load(best.word, p);
      if (pg.articles === 0 && pg.count > 0) stop('layout_changed', searchUrl(best.word, p), 'results page has no result list');
      for (const e of pg.entries) {
        if (keyOf(e.name) !== target) continue;
        const url = new URL(e.href, SITE).href;
        const id = (e.href.match(/\/provider\/([^/?#]+)/) || [])[1] || '';
        const dedupe = `${e.entry_type}|${url}|${e.location_name}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        matches.push({
          name: e.name,
          provider_id: id,
          entry_type: e.entry_type,
          also_known_as: e.also_known_as,
          address: e.address,
          phone: e.phone,
          location_name: e.location_name,
          url,
        });
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: searchUrl(best.word),
        excerpt: `${matches.length} CQC entr${matches.length === 1 ? 'y' : 'ies'} named "${matches[0].name}"`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl(best.word),
      excerpt: `Read all ${best.count} CQC results for "${best.word}" (${pagesNeeded} pages); no provider named "${keyword}"`,
    };
  } catch (e) {
    if (e && e.cqc) return fail(e.reason, e.url, e.message);
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return fail('timeout', SEARCH, 'the CQC site did not answer in 25 s');
    return fail('other', SEARCH, String((e && e.message) || e));
  }
}
