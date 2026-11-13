export const meta = {
  task: 'NZ-hospitality.org.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'partner_url', 'headline'],
  canary: { found: 'AMS Nightlife', not_found: 'Te Whare Kai Pūkeko Limited' },
};

// The site's partner / affiliate directory (htmx fragment). Keyword search: ?keywords=...&offset=<page>, 12 per page.
const BASE = 'https://www.hospitality.org.nz/filter-affiliates/affiliate';
const SITE = 'https://www.hospitality.org.nz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co', 'llc', 'pty']);
const NO_RESULTS = 'No partners found.';
const MAX_PAGES = 10;
const DEADLINE_MS = 45000;

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&');
}

function words(s) {
  return decode(s).toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

function dropLegal(ws) {
  const w = ws.slice();
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

/** Normalised comparison key: case, punctuation, '&' vs 'and' and trailing legal form are ignored. */
function key(s) {
  return dropLegal(words(s)).join('');
}

/** The keyword as sent to the site: the typed name with a trailing legal form removed. */
function searchTerm(keyword) {
  const parts = decode(keyword).trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && LEGAL.has(words(parts[parts.length - 1]).join(''))) parts.pop();
  return parts.join(' ');
}

/** A card name matches on its full text, or on the part before a " - " tagline (e.g. "One NZ - Let's get connected"). */
function candidateKeys(name) {
  const first = name.split(/\s+-\s+|\s+–\s+/)[0];
  return [key(name), key(first)];
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Each partner card: its <h3> name, and the card's own link (href + title = the one-line headline). */
function cards(html) {
  const out = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<a href="(\/partners\/[^"]*)"[^>]*?title="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ name: cleanText(m[1]), path: m[2], headline: cleanText(m[3]) });
  }
  return out;
}

function listName(path) {
  if (path.startsWith('/partners/affiliate-businesses/')) return 'Affiliate Businesses';
  if (path.startsWith('/partners/partner/')) return 'Partners';
  return 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  const term = searchTerm(input);
  const target = key(input);
  const firstUrl = `${BASE}?keywords=${encodeURIComponent(term)}&offset=0`;
  if (!term || !target) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
  }

  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  const records = [];
  let finished = false;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: firstUrl, excerpt: 'paging did not finish in time' };
      }
      const url = `${BASE}?keywords=${encodeURIComponent(term)}&offset=${page}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: firstUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: firstUrl, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();
      if (html.includes(NO_RESULTS)) {
        finished = true;
        break;
      }
      const list = cards(html);
      if (list.length === 0) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }
      for (const c of list) {
        if (candidateKeys(c.name).includes(target)) {
          records.push({
            name: c.name,
            list: listName(c.path),
            partner_url: new URL(c.path, SITE).href,
            headline: c.headline,
          });
        }
      }
    }
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }

  if (!finished) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'more result pages than the handler reads' };
  }

  if (records.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `No partner or affiliate named "${input}" is listed on the site (searched "${term}")`,
    };
  }

  return {
    status: 'found',
    reason: '',
    records,
    source_url: firstUrl,
    excerpt: records.map((r) => `${r.name} (${r.list}): ${r.headline}`).join(' | ').slice(0, 500),
  };
}
