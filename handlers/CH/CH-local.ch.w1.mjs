export const meta = { task: 'CH-local.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'address', 'detail_url'],
  canary: { found: 'Nestlé AG', not_found: 'Zxqvbnm Handels GmbH' } };

const BASE = 'https://www.local.ch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // local.ch shows 20 listings per page; stop after 100 listings
const NEXT_PAGE_BY_MS = 30000; // never start a new page after 30 s, so the whole call ends well under 60 s
const BLOCK_RE = /captcha|cf-chl|challenge-platform|access denied|unusual traffic/i;

// Long legal-form words -> the short form the site and people use (applied after normalising).
const LEGAL_FORMS = [
  [/\baktiengesellschaft\b/g, 'ag'],
  [/\bgesellschaft mit beschrankter haftung\b/g, 'gmbh'],
  [/\bsociete anonyme\b|\bsocieta anonima\b/g, 'sa'],
  [/\blimited\b/g, 'ltd'],
  [/\bincorporated\b/g, 'inc'],
];

/** Case, accents, punctuation and legal-form spelling removed: "Nestle AG" == "NESTLÉ A.G." == "Nestlé AG". */
function normalize(str) {
  let s = String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/\.(?=\p{L})/gu, '');        // "s.a." -> "sa"
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const [re, rep] of LEGAL_FORMS) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function searchUrl(name, page) {
  return `${BASE}/en/s/Switzerland/${encodeURIComponent(name)}` + (page > 1 ? `?page=${page}` : '');
}

/** Total listings the search reports ("0 results", "54 results"). null when the page does not say. */
function parseTotal(html) {
  const m = html.match(/\\?"totalResults\\?":\s*(\d+)/) || html.match(/>\s*(\d+)\s+results?\s*</i);
  return m ? Number(m[1]) : null;
}

/** One entry per listing card on a results page. Each card starts with an <article> and a link named after the company. */
function parseCards(html) {
  const cards = [];
  for (const part of html.split('<article ').slice(1)) {
    const link = part.match(/<a aria-label="([^"]*)"[^>]*href="(\/en\/d\/[^"]*)"/);
    if (!link) continue;
    const addr = part.match(/lucide-map-pin[\s\S]*?<\/svg><\/span>([\s\S]*?)<\/div>/);
    cards.push({
      name: decodeEntities(link[1]).trim(),
      address: addr ? cleanText(addr[1]) : '',
      detail_url: new URL(decodeEntities(link[2]), BASE).href,
    });
  }
  return cards;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const firstUrl = searchUrl(name, 1);
  const want = normalize(name);
  if (!want) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
  }

  try {
    const matches = [];
    const seen = new Set();
    let total = null;
    let matchUrl = firstUrl;
    let lastPage = 0;
    let endedEarly = false; // true when a page had no listings at all

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > NEXT_PAGE_BY_MS) break;
      const url = searchUrl(name, page);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const pageTotal = parseTotal(html);
      const cards = parseCards(html);

      if (pageTotal === null && cards.length === 0) {
        if (BLOCK_RE.test(html)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: html.slice(0, 300) };
      }
      if (pageTotal !== null) total = pageTotal;
      lastPage = page;

      let fresh = 0;
      for (const card of cards) {
        if (seen.has(card.detail_url)) continue;
        seen.add(card.detail_url);
        fresh++;
        if (normalize(card.name) === want) {
          if (matches.length === 0) matchUrl = url;
          matches.push({ name: card.name, address: card.address, detail_url: card.detail_url });
        }
      }

      if (cards.length === 0) { endedEarly = true; break; }   // no more listings
      if (total !== null && seen.size >= total) break;          // every listing was read
      if (fresh === 0) break;                                   // page repeats earlier ones
    }

    if (matches.length > 0) {
      return {
        status: 'found', reason: '', records: matches, source_url: matchUrl,
        excerpt: `${matches.length} listing(s) named "${matches[0].name}" on local.ch (${seen.size} of ${total ?? '?'} results read)`,
      };
    }

    const complete = total !== null ? seen.size >= total : endedEarly;
    if (total === 0 || (complete && total !== null)) {
      return {
        status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: total === 0 ? '0 results' : `${total} results read, none named "${name}"`,
      };
    }
    if (total !== null && seen.size === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl,
        excerpt: `local.ch reports ${total} results but no listing could be read` };
    }
    return {
      status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl(name, lastPage || 1),
      excerpt: `no exact match in the ${seen.size} of ${total ?? '?'} results read (pages 1-${lastPage})`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
