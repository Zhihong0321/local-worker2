export const meta = { task: 'IN-nasscom.in', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'city', 'website'],
  canary: { found: 'Infosys Limited', not_found: 'गणेश सॉफ्टवेयर प्राइवेट लिमिटेड' } };

// NASSCOM "Members Listing" (https://nasscom.in/members-listing) has a server-side name filter: ?title=<text>.
// It matches a substring of the member name. Each entry shows the name, the city and the member's own website.
const BASE = 'https://nasscom.in/members-listing';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BUDGET_MS = 50000;   // the whole call must finish in under 60 s
const MAX_PAGES = 3;       // per query
const LEGAL = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'llc', 'inc', 'incorporated', 'opc', 'corporation', 'corp', 'company', 'co']);

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower case, no punctuation or spaces, no legal-form words: "Infosys Ltd." -> "infosys". */
function normalize(str) {
  return decode(str).toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((t) => t && !LEGAL.has(t)).join('');
}

/** The name without its legal form, as the user typed it: "ACME TECH PVT LTD" -> "ACME TECH". */
function coreName(term) {
  return decode(term)
    .split(' ')
    .filter((w) => !LEGAL.has(w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '')))
    .join(' ')
    .replace(/[.,;:]+$/, '')
    .trim();
}

/** Member cards on one listing page: [{ name, city, website }]. */
function parseEntries(html) {
  const out = [];
  for (const part of html.split('<div class="perspectives_card_content">').slice(1)) {
    const h = part.match(/<h3 class="job_title">([\s\S]*?)<\/h3>/);
    if (!h) continue;
    const city = part.match(/<div class="category">([\s\S]*?)<\/div>/);
    const link = part.match(/<a href="(https?:\/\/[^"]+)"/);
    out.push({ name: decode(h[1]), city: city ? decode(city[1]) : '', website: link ? decode(link[1]) : '' });
  }
  return out;
}

/** One listing page. Returns { html } or { error, url, detail }. Never throws. */
async function fetchPage(url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 3000) return { error: 'timeout', url, detail: 'time budget used up before this request' };
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(Math.min(25000, remaining)),
    });
    if (res.status === 403 || res.status === 429) return { error: 'blocked', url, detail: `HTTP ${res.status}` };
    if (!res.ok) return { error: 'http_error', url, detail: `HTTP ${res.status}` };
    const html = await res.text();
    if (!html.includes('member-listing')) {
      if (/Just a moment\.\.\.|cf-chl-|challenge-form|Access denied/i.test(html)) return { error: 'blocked', url, detail: 'bot check page' };
      return { error: 'layout_changed', url, detail: html.slice(0, 300) };
    }
    return { html };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { error: timeout ? 'timeout' : 'other', url, detail: String(e?.message || e).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const deadline = Date.now() + BUDGET_MS;
    const term = decode(keyword);
    const target = normalize(term);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no usable company name' };
    }

    // The site matches a substring, so try the name as typed, then without its legal form.
    const queries = [...new Set([term, coreName(term)].filter(Boolean))];
    const matches = [];
    let matchUrl = '';
    let firstUrl = '';
    let failure = null;
    let seen = 0;

    queryLoop:
    for (const q of queries) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${BASE}?title=${encodeURIComponent(q)}${page ? `&page=${page}` : ''}`;
        if (!firstUrl) firstUrl = url;
        const got = await fetchPage(url, deadline);
        if (got.error) {
          failure = failure || got;
          break;
        }
        const entries = parseEntries(got.html);
        seen += entries.length;
        const hits = entries.filter((e) => normalize(e.name) === target);
        if (hits.length) {
          matches.push(...hits);
          matchUrl = url;
          break queryLoop;
        }
        // Next page only when this page had entries and the site offers one.
        if (!entries.length || !/rel="next"/.test(got.html)) break;
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((m) => ({ name: m.name, city: m.city, website: m.website })),
        source_url: matchUrl,
        excerpt: matches.map((m) => `${m.name} (${m.city})`).join('; ').slice(0, 500),
      };
    }
    if (failure) {
      return { status: 'couldnt_check', reason: failure.error, records: [], source_url: failure.url, excerpt: failure.detail };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `Members listing: no entry matches "${term}" (searched: ${queries.join(' | ')}; ${seen} entries seen)`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
