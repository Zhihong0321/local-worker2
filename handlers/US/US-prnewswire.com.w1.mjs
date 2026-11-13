export const meta = { task: 'US-prnewswire.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'profile_url'], canary: { found: 'Microsoft Corp.', not_found: 'Dezeno' } };

// PR Newswire organization search: a plain GET page, server-rendered, 10 results per page.
// e.g. https://www.prnewswire.com/search/organization/?keyword=Microsoft
// The site returns 0 results for legal-form words ("Microsoft Corporation"), so the search
// uses the name without its legal form, and the match is done afterwards on normalised names.
const SEARCH = 'https://www.prnewswire.com/search/organization/';
const BASE = 'https://www.prnewswire.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const MAX_PAGES = 5;
const TIME_BUDGET_MS = 40000;
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'llp',
  'lp', 'plc', 'pllc', 'gmbh', 'pty', 'pvt', 'sdn', 'bhd', 'pte']);

function words(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** Normalised name for matching: case, punctuation, leading "the" and trailing legal form removed. */
function core(name) {
  const w = words(name);
  if (w[0] === 'the') w.shift();
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join('');
}

/** Words sent to the site: the name with legal-form words removed. */
function searchQuery(name) {
  const w = words(name);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ') || String(name || '').trim();
}

function decode(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function parseItems(html) {
  const section = html.match(/<section[^>]*search-results-text[\s\S]*?<\/section>/i)?.[0] || '';
  const items = [];
  const re = /<a href="(\/news\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    const name = decode(m[2]);
    if (name) items.push({ name, profile_url: new URL(m[1], BASE).href });
  }
  return items;
}

async function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const q = searchQuery(keyword);
  const firstUrl = `${SEARCH}?keyword=${encodeURIComponent(q)}`;
  try {
    const started = Date.now();
    const wanted = core(keyword);
    const hits = [];
    let total = 0;
    let scanned = 0;
    let summary = '';
    for (let page = 1; ; page++) {
      const url = page === 1 ? firstUrl : `${firstUrl}&page=${page}`;
      const res = await get(url);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      if (/<title>[^<]*(Just a moment|Attention Required|Access denied|Access Denied)/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
      }
      const m = html.match(/Displaying Results\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
      if (!m) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: decode(html).slice(0, 300) };
      }
      total = Number(m[3]);
      summary = decode(m[0]) + ` for "${q}"`;
      const items = parseItems(html);
      if (total > 0 && items.length === 0 && page === 1) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: summary };
      }
      scanned += items.length;
      for (const it of items) {
        if (core(it.name) === wanted && !hits.some((h) => h.profile_url === it.profile_url)) hits.push(it);
      }
      const more = page * PAGE_SIZE < total;
      if (!more || items.length === 0) break;
      if (page >= MAX_PAGES || Date.now() - started > TIME_BUDGET_MS) break;
    }

    if (hits.length > 0) {
      return {
        status: 'found', reason: '', records: hits, source_url: firstUrl,
        excerpt: `${summary}: ${hits.map((h) => h.name).join('; ')}`.slice(0, 500),
      };
    }
    if (scanned >= total) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl, excerpt: summary };
    }
    return {
      status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
      excerpt: `${summary}; only ${scanned} of ${total} results were read, no exact match yet`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
