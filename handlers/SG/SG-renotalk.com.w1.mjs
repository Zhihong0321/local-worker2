export const meta = {
  task: 'SG-renotalk.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'category', 'verified', 'slug'],
  canary: { found: 'ExQsite Interior Design Pte Ltd', not_found: '新加坡虚构装修工程有限公司' },
};

const BASE = 'https://www.renotalk.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 12;          // the site shows 12 pros per page
const MAX_PAGES = 15;         // more than this = couldnt_check, never a guessed not_found
const DEADLINE_MS = 45000;    // stay well under the 60 s limit

const LEGAL_FORM = new Set(['pte', 'ltd', 'limited', 'sdn', 'bhd', 'llp', 'llc', 'pvt', 'private', 'inc', 'co', 'company']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&#0?39;|&#x27;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(s) {
  return decodeEntities((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised company name: lower case, no punctuation, no legal-form words. Keeps non-Latin letters. */
function coreName(str) {
  let tokens = cleanText(str).toLowerCase().replace(/&/g, ' and ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  tokens = tokens.filter((t) => !LEGAL_FORM.has(t));
  if (tokens.length > 1 && tokens[0] === 'the') tokens = tokens.slice(1);   // "The Safe Haven Interiors" = "Safe Haven Interiors"
  return tokens.join('');
}

function blockedText(html) {
  return /captcha|cf-chl|just a moment|attention required|access denied/i.test(html);
}

/** Fetch one search page. Returns { ok:true, html } or { ok:false, reason, excerpt }. */
async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-SG,en;q=0.9' },
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, reason: 'timeout', excerpt: String(e?.message || e).slice(0, 200) };
  }
  if (blockedText(html)) return { ok: false, reason: 'blocked', excerpt: 'bot or captcha page' };
  return { ok: true, html };
}

function searchUrl(query, page) {
  const p = new URLSearchParams({ q: query });
  if (page > 1) p.set('page', String(page));
  return `${BASE}/professionals?${p.toString()}`;
}

/** Parse one results page: total count (null if the counter is missing) and the pro cards on it. */
function parsePage(html) {
  const counter = html.match(/font-size:14px;font-weight:800">\s*(\d+)\s+pros?\s*<\/span>/);
  if (!counter) return null;
  const total = Number(counter[1]);
  const cards = [];
  const anchor = /<a href="https:\/\/www\.renotalk\.com\/professionals\/([^"\/?#]+)" style="display:flex;gap:12px[^"]*">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchor.exec(html)) !== null) {
    const block = m[2];
    const nameM = block.match(/font-weight:800;font-size:15px[^"]*">([^<]*)<\/span>/);
    if (!nameM) continue;
    const catM = block.match(/<div style="font-size:12px;color:#4F4A43">([^<]*?)(?:\s·|<)/);
    cards.push({
      slug: decodeURIComponent(m[1]),
      name: cleanText(nameM[1]),
      category: catM ? cleanText(catM[1]) : '',
      verified: /✓<\/span>Verified/.test(block),
    });
  }
  return { total, cards };
}

/** Scan every results page for one query. Returns { status, matches, scanned, total, url } */
async function scanQuery(query, started) {
  const matches = [];
  const first = searchUrl(query, 1);
  let total = null;
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() - started > DEADLINE_MS) return { status: 'couldnt_check', reason: 'timeout', url: first, matches, seen, total };
    const got = await fetchPage(searchUrl(query, page));
    if (!got.ok) return { status: 'couldnt_check', reason: got.reason, url: searchUrl(query, page), excerpt: got.excerpt, matches, seen, total };
    const parsed = parsePage(got.html);
    if (!parsed) return { status: 'couldnt_check', reason: 'layout_changed', url: searchUrl(query, page), excerpt: cleanText(got.html).slice(0, 200), matches, seen, total };
    total = parsed.total;
    if (total === 0) return { status: 'ok', matches, seen: 0, total: 0, url: first };
    if (parsed.cards.length === 0) return { status: 'couldnt_check', reason: 'layout_changed', url: searchUrl(query, page), excerpt: `counter says ${total} but no cards parsed`, matches, seen, total };
    seen += parsed.cards.length;
    for (const c of parsed.cards) {
      if (coreName(c.name) === coreName(query)) matches.push(c);
    }
    if (seen >= total) return { status: 'ok', matches, seen, total, url: first };
  }
  return { status: 'couldnt_check', reason: 'other', url: first, excerpt: `more than ${MAX_PAGES} pages of results (${total} pros); not scanned in full`, matches, seen, total };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const typed = cleanText(String(keyword || ''));
    const core = coreName(typed);
    if (!typed || !core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + '/professionals', excerpt: 'no company name in the input' };
    }

    // Query 1: the name as typed. Query 2 (only if different): the name without its legal form.
    const queries = [typed];
    const stripped = typed.split(/\s+/).filter((t) => !LEGAL_FORM.has(t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))).join(' ');
    if (stripped && stripped !== typed) queries.push(stripped);

    const found = new Map();
    let firstUrl = searchUrl(typed, 1);
    let scanned = 0;
    for (const q of queries) {
      const r = await scanQuery(q, started);
      if (r.status !== 'ok') {
        // A matching pro found before the failure is still a real match; otherwise the site did not answer in full.
        if (r.matches.length > 0) {
          for (const c of r.matches) found.set(c.slug, c);
          break;
        }
        return { status: 'couldnt_check', reason: r.reason, records: [], source_url: r.url, excerpt: r.excerpt || `query "${q}" incomplete` };
      }
      scanned += r.seen;
      for (const c of r.matches) found.set(c.slug, c);
      if (found.size > 0) break;
    }

    if (found.size === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `RenoTalk pro search for "${typed}": no pro with this name (${scanned} results checked)`,
      };
    }

    const records = [...found.values()].map((c) => ({
      name: c.name,
      profile_url: `${BASE}/professionals/${encodeURIComponent(c.slug)}`,
      category: c.category,
      verified: c.verified,
      slug: c.slug,
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url,
      excerpt: `RenoTalk pro listing: ${records[0].name} (${records[0].category || 'category not shown'}${records[0].verified ? ', verified' : ''})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl(String(keyword || ''), 1),
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
