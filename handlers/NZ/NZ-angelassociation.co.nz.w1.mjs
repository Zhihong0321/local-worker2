export const meta = { task: 'NZ-angelassociation.co.nz', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'category', 'listing_url'],
  canary: { found: 'MIG Angels', not_found: 'Whakaaro Kōwhai Ngātahi Limited' } };

const BASE = 'https://www.angelassociation.co.nz/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co', 'llc', 'lp']);

/** Lower-case, no macrons/accents, letters and digits only. "MIG Angels Ltd." -> "miganges"-style key. */
function key(str) {
  return (str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Name words with the legal form removed (only trailing/standalone legal words, e.g. "Limited", "Ltd"). */
function coreWords(keyword) {
  return keyword.trim().split(/\s+/).filter((w) => !LEGAL.has(key(w)));
}

function decode(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const words = coreWords(keyword);
    const query = (words.length ? words : keyword.trim().split(/\s+/)).join(' ');
    searchUrl = `${BASE}?mylisting-ajax=1&action=mylisting_quick_search&s=${encodeURIComponent(query)}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.text();

    if (res.status === 403 || res.status === 429 || /challenge-platform|cf-chl|Just a moment/i.test(body.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    let json;
    try { json = JSON.parse(body); } catch { json = null; }
    if (!json || typeof json.content !== 'string') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: body.slice(0, 300) };
    }

    // The endpoint answers with an HTML fragment: category headings (<li class="ir-cat">) and listing links.
    if (json.content.trim() === '') {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 listings for "${query}"` };
    }

    const listings = [];
    let category = '';
    const re = /<li class="ir-cat">([\s\S]*?)<\/li>|<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(json.content))) {
      if (m[1] !== undefined) { category = decode(m[1]); continue; }
      const nameMatch = m[3].match(/<span class="category-name">([\s\S]*?)<\/span>/);
      if (!nameMatch) continue;
      listings.push({ name: decode(nameMatch[1]), category, listing_url: m[2] });
    }

    if (listings.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: decode(json.content).slice(0, 300) };
    }

    // Match the company, not similar words: compare the names with case, punctuation, accents and legal form removed.
    const target = key(coreWords(keyword).join(' ') || keyword);
    const matches = listings.filter((l) => key(coreWords(l.name).join(' ')) === target);

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${listings.length} listing(s) returned for "${query}", none with this name: ${listings.map((l) => l.name).join('; ')}`.slice(0, 500),
      };
    }

    return {
      status: 'found', reason: '', records: matches, source_url: matches[0].listing_url,
      excerpt: `${matches[0].name} (${matches[0].category}) listed on ${BASE}`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [],
      source_url: searchUrl || BASE, excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
