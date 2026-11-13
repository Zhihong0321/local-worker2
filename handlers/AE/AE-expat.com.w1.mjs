export const meta = {
  task: 'AE-expat.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'description', 'listing_url', 'listed'],
  canary: { found: 'Nordvia Digital', not_found: 'شركة زيدنو للتجارة العامة ذ.م.م' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://www.expat.com/en/searchresult/middle-east/united-arab-emirates/';
const DIRECTORY_TYPE = 'Business directory';

// Legal-form words are dropped from both sides before comparing, so "ACME TRADING LLC" matches "Acme Trading".
const LEGAL_LATIN = /\b(l\.?\s?l\.?\s?c|fz\s?-?\s?llc|fzco|fze|fz|llp|pjsc|psc|est|establishment)\b\.?/gi;
const LEGAL_ARABIC = /ش\s*\.?\s*ذ\s*\.?\s*م\s*\.?\s*م\s*\.?|ذ\s*\.?\s*م\s*\.?\s*م\s*\.?/g;

function stripLegal(s) {
  return (s || '').replace(LEGAL_LATIN, ' ').replace(LEGAL_ARABIC, ' ');
}

/** Same name = same letters and digits, lower case, no punctuation, no legal form, Arabic spelling variants folded. */
function normalize(s) {
  const t = stripLegal(String(s || '').normalize('NFKC').toLowerCase())
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
  return t.replace(/[^\p{L}\p{N}]+/gu, '');
}

function cleanText(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** Pull the JSON array that follows "<key>": out of the page's embedded data (string-aware bracket matching). */
function extractArray(html, key) {
  const marker = `"${key}":[`;
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length - 1;
  let depth = 0;
  let inStr = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  return null;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const query = stripLegal(String(keyword || '')).replace(/\s+/g, ' ').trim() || String(keyword || '').trim();
  const sourceUrl = `${SEARCH}?q=${encodeURIComponent(query)}`;
  if (!query) return couldnt('other', SEARCH, 'empty company name');

  try {
    const res = await fetch(sourceUrl, {
      // Connection: close stops a kept-alive socket from holding the process open at exit (Node on Windows aborts otherwise).
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return couldnt('blocked', sourceUrl, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', sourceUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (/cf-chl|challenge-platform|<title>\s*Just a moment/i.test(html)) return couldnt('blocked', sourceUrl, 'bot check page');

    const raw = extractArray(html, 'searchResults');
    if (raw === null) return couldnt('layout_changed', sourceUrl, html.slice(0, 300));

    let results;
    try {
      results = JSON.parse(raw);
    } catch {
      return couldnt('layout_changed', sourceUrl, 'search results are not readable JSON');
    }
    if (!Array.isArray(results)) return couldnt('layout_changed', sourceUrl, 'search results are not a list');

    // Only directory listings are company records; forum topics that mention a name are not.
    const want = normalize(keyword);
    const records = results
      .filter((r) => r && r.type === DIRECTORY_TYPE && want && normalize(r.title) === want)
      .map((r) => ({
        name: cleanText(r.title),
        category: cleanText(r.category && r.category.label),
        description: cleanText(r.description),
        listing_url: new URL(r.link, 'https://www.expat.com').href,
        listed: cleanText(r.date),
      }));

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `0 directory listings match "${keyword}" among ${results.length} search results`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: `${records.length} directory listing(s): ${records.map((r) => `${r.name} (${r.category})`).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', sourceUrl, String(err?.message || err).slice(0, 300));
  }
}
