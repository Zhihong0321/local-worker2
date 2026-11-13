export const meta = {
  task: 'NZ-nzwine.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'region', 'cellar_door_address', 'phone', 'email', 'website', 'detail_url'],
  canary: { found: 'Amisfield', not_found: 'Te Kāhui Pōtae Wainga' },
};

const BASE = 'https://www.nzwine.com';
const DIRECTORY = `${BASE}/en/winery-directory/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'co', 'company', 'inc', 'incorporated', 'llc', 'pty', 'lp', 'plc']);
const MAX_PAGES = 10;          // 10 pages x 50 results: more than that is couldnt_check, never not_found
const DEADLINE_MS = 50000;     // whole call must finish under 60 s
const MAX_DETAILS = 5;

/** A failure with a reason the contract allows. */
class Fail extends Error {
  constructor(reason, excerpt, url) {
    super(excerpt);
    this.reason = reason;
    this.url = url;
  }
}

/** Lower case, no accents, no punctuation: the form used to compare names. */
function fold(str) {
  return (str || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The words that identify the company: legal form and a leading "the" removed. */
function coreWords(name) {
  let words = fold(name).split(' ').filter((w) => w && !LEGAL_FORMS.has(w));
  if (words.length > 1 && words[0] === 'the') words = words.slice(1);
  return words;
}

function decode(str) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Fetch one page of the site. Every failure becomes a Fail with a reason. */
async function getPage(url, started) {
  const left = DEADLINE_MS - (Date.now() - started);
  if (left < 3000) throw new Fail('timeout', 'ran out of time before the site answered', url);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(Math.min(25000, left)),
    });
    if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`, url);
    if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`, url);
    const html = await res.text();
    const hasDirectory = /c-winery-directory|c-winery-brand|js-winery-name|show-result-text|no matching wineries/.test(html);
    if (!hasDirectory && /captcha|cf-chl|just a moment\.\.\./i.test(html)) throw new Fail('blocked', 'bot check page', url);
    return html;
  } catch (err) {
    if (err instanceof Fail) throw err;
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Fail(timedOut ? 'timeout' : 'other', String(err?.message || err).slice(0, 300), url);
  }
}

/** Run the site's own name filter once (all result pages) and return the listed wineries. */
async function searchDirectory(query, started) {
  const hits = [];
  const seen = new Set();
  let noMatch = false;
  let page = 1;
  let maxPage = 1;
  const searchUrl = `${DIRECTORY}?q=${encodeURIComponent(query)}`;
  do {
    const url = page === 1 ? searchUrl : `${searchUrl}&page=${page}`;
    const html = await getPage(url, started);
    if (!/c-winery-directory|show-result-text|no matching wineries/.test(html)) {
      throw new Fail('layout_changed', html.slice(0, 300), url);
    }
    if (/no matching wineries/i.test(html)) noMatch = true;
    for (const m of html.matchAll(/<a href="(\/en\/winery\/[^"#?]+)" class="item-title[^"]*">([\s\S]*?)<\/a>/g)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        hits.push({ slug: m[1], title: clean(m[2]) });
      }
    }
    for (const p of html.matchAll(/[?&]page=(\d+)/g)) maxPage = Math.max(maxPage, Number(p[1]));
    page++;
  } while (page <= maxPage && page <= MAX_PAGES);
  if (page <= maxPage) {
    throw new Fail('other', `more than ${MAX_PAGES * 50} results for "${query}", cannot check all of them`, searchUrl);
  }
  if (hits.length === 0 && !noMatch) {
    throw new Fail('layout_changed', 'results page has neither entries nor the no-match text', searchUrl);
  }
  return { hits, url: searchUrl };
}

/** Read one winery detail page. */
async function readWinery(hit, started) {
  const url = new URL(hit.slug, BASE).href;
  const html = await getPage(url, started);
  const nameM = html.match(/<h1[^>]*js-winery-name[^>]*>([\s\S]*?)<\/h1>/);
  if (!nameM) throw new Fail('layout_changed', 'winery page has no name heading', url);
  const pick = (re) => clean((html.match(re) || [])[1] || '');
  const record = {
    name: clean(nameM[1]),
    region: pick(/<h1[^>]*js-winery-name[\s\S]*?<div class="c-layout-header__lede[^"]*">([\s\S]*?)<\/div>/),
    cellar_door_address: pick(/Cellar door address<\/h4>\s*<p class="c-winery-visit__item-text">([\s\S]*?)<\/p>/),
    phone: pick(/>Phone<\/div>\s*<div class="c-winery-contacts__item-content[^"]*">([\s\S]*?)<\/div>/),
    email: pick(/<a type="email" href="mailto:([^"?]+)"/),
    website: pick(/<a href="([^"]+)" class="c-winery-contacts__website-link/),
    detail_url: url,
  };
  return { record, html };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Node on Windows can abort at process exit while a just-used connection is still closing.
  // A short pause lets the connections settle before the caller exits.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function run(keyword) {
  const started = Date.now();
  try {
    const words = coreWords(keyword);
    if (words.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY, excerpt: 'no company name in the input' };
    }
    const target = words.join('');

    // The site filters by a plain substring of the winery name, so try the longest word prefix first
    // and shorten it until the exact name comes up. Each prefix is a real search on the site.
    let matches = [];
    let lastSearchUrl = DIRECTORY;
    let lastQuery = '';
    for (let n = words.length; n >= 1 && matches.length === 0; n--) {
      const query = words.slice(0, n).join(' ');
      const result = await searchDirectory(query, started);
      lastSearchUrl = result.url;
      lastQuery = query;
      matches = result.hits.filter((h) => coreWords(h.title).join('') === target);
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: lastSearchUrl,
        excerpt: `The NZ Winegrowers winery directory has no winery matching "${keyword}" (last search: "${lastQuery}").`,
      };
    }

    const records = [];
    let firstExcerpt = '';
    for (const hit of matches.slice(0, MAX_DETAILS)) {
      const { record } = await readWinery(hit, started);
      records.push(record);
      if (!firstExcerpt) {
        firstExcerpt = [record.name, record.region, record.cellar_door_address && `cellar door: ${record.cellar_door_address}`, record.phone && `phone: ${record.phone}`]
          .filter(Boolean).join('; ');
      }
    }
    return { status: 'found', reason: '', records, source_url: records[0].detail_url, excerpt: firstExcerpt.slice(0, 500) };
  } catch (err) {
    if (err instanceof Fail) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url || DIRECTORY, excerpt: err.message.slice(0, 300) };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
