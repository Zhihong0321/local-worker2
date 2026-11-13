export const meta = { task: 'GB-fmb.org.uk', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'profile_url', 'membership', 'location'],
  canary: { found: 'C Smith Carpentry & Joinery Ltd', not_found: 'Zqxwvut Nonexistent Holdings Ltd' } };

const BASE = 'https://www.fmb.org.uk';
const SEARCH = `${BASE}/find-a-builder.html`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' };
const PAGE_SIZE = 20;      // the site shows 20 builders per results page
const MAX_PAGES = 5;       // at most 100 results read for one name
const SOFT_DEADLINE_MS = 30000; // no new request starts after this, so the whole call stays under 60 s
const LEGAL_WORDS = new Set(['ltd', 'limited', 'llp', 'plc']);

function decode(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

/** Name as the site writes it -> compare key: case, punctuation, "&"/"and" and the legal form at the end are dropped. */
function nameKey(name) {
  const words = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && w !== 'and');
  while (words.length > 1 && LEGAL_WORDS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** The search text: the name as typed, minus a trailing legal form (the site's search is looser without it). */
function searchText(input) {
  const words = input.split(' ');
  while (words.length > 1 && LEGAL_WORDS.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) words.pop();
  return words.join(' ');
}

/** Reads one results page. Returns null when the page is not the results layout we know. */
function parseResults(html) {
  const countM = html.match(/results-count-text-count">\s*(\d+)\s*</);
  const start = html.indexOf('id="result-section-builders"');
  if (!countM || start < 0) return null;
  const end = html.indexOf('search-result-pagination', start);
  const section = html.slice(start, end > start ? end : undefined);
  const items = [];
  const re = /<article class="article-list-item">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(section))) {
    const link = m[1].match(/<a href="([^"]+)" class="article-title-link">([\s\S]*?)<\/a>/);
    if (!link) continue;
    const teaser = m[1].match(/<div class="article-teaser">\s*<p>([\s\S]*?)<\/p>/);
    let profileUrl = '';
    try { const u = new URL(link[1].replace(/ /g, '%20'), BASE); profileUrl = `${u.origin}${u.pathname}`; } catch (e) { profileUrl = ''; }
    items.push({ name: decode(link[2]), profile_url: profileUrl, teaser: teaser ? decode(teaser[1]) : '' });
  }
  return { total: Number(countM[1]), items };
}

/** One GET. Returns { html } or { fail: true, reason, excerpt }. */
async function getPage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { fail: true, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { fail: true, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    if (/<title>\s*(Just a moment|Attention Required)/i.test(html.slice(0, 5000))) {
      return { fail: true, reason: 'blocked', excerpt: 'bot check page' };
    }
    return { html };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: true, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').replace(/\s+/g, ' ').trim();
  if (!input) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH, excerpt: 'empty company name' };
  }
  try {
    const q = searchText(input) || input;
    const key = nameKey(input);
    const matches = [];
    let total = null;
    let pagesRead = 0;
    let firstUrl = '';

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > SOFT_DEADLINE_MS) break;
      const url = `${SEARCH}?name=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;
      if (!firstUrl) firstUrl = url;
      const got = await getPage(url);
      if (got.fail) return { status: 'couldnt_check', reason: got.reason, records: [], source_url: url, excerpt: got.excerpt };

      const parsed = parseResults(got.html);
      if (!parsed) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: decode(got.html).slice(0, 300) };
      }
      if (total === null) total = parsed.total;
      pagesRead++;
      for (const item of parsed.items) {
        if (nameKey(item.name) === key) matches.push(item);
      }
      if (parsed.items.length === 0 || pagesRead * PAGE_SIZE >= total) break;
    }

    if (matches.length > 0) {
      const records = [];
      for (const m of matches.slice(0, 5)) {
        let location = '';
        if (Date.now() - started < SOFT_DEADLINE_MS) {
          const detail = await getPage(m.profile_url);
          if (!detail.fail) {
            const loc = detail.html.match(/ico-fmb-pin[^>]*><\/span>\s*Based in\s+([^<]+)/);
            if (loc) location = decode(loc[1]);
          }
        }
        const since = m.teaser.match(/(has been a FMB member since [^.]+)/);
        records.push({ name: m.name, profile_url: m.profile_url, membership: since ? since[1] : '', location });
      }
      return { status: 'found', reason: '', records, source_url: matches[0].profile_url, excerpt: matches[0].teaser.slice(0, 500) };
    }

    if (pagesRead * PAGE_SIZE < total) {
      // Results exist that were not read (deadline or page cap): cannot say it is not there.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
        excerpt: `read ${pagesRead * PAGE_SIZE} of ${total} results for "${q}", no exact name match yet` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
      excerpt: `${total} result(s) for "${q}", none named "${input}"` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
