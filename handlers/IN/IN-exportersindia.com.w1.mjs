export const meta = {
  task: 'IN-exportersindia.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'business_type', 'address', 'deals_in', 'verified_member'],
  canary: { found: 'Tata Motors', not_found: 'ज़ेडक्सवेक्स ट्रेडर्स प्राइवेट लिमिटेड' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.exportersindia.com/search.php';
const PAGE_SIZE = 50;        // the site lists 50 companies per result page
const MAX_PAGES = 5;         // at most 250 listings are read per lookup
const PAGE_BUDGET_MS = 30000; // do not start a new result page after this; keeps the whole call under 60 s

// Legal-form words that are dropped before comparing names (English and Hindi).
const LEGAL = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'corp', 'corporation', 'company', 'co', 'opc',
  'plc', 'llc', 'sdn', 'bhd', 'pte',
  'प्राइवेट', 'प्रा', 'लिमिटेड', 'लि', 'एलएलपी', 'कंपनी',
]);

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a company name into words, keeping Devanagari vowel signs (combining marks) inside the words. */
function words(s) {
  return String(s || '').normalize('NFKC').split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
}

function fetchFail(err, url) {
  const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return {
    status: 'couldnt_check',
    reason: timeout ? 'timeout' : 'other',
    records: [],
    source_url: url,
    excerpt: String((err && err.message) || err).slice(0, 300),
  };
}

/** Read the company cards on one result page. */
function parseCards(html) {
  const parts = html.split('<div class="fo pr bdr bsb5px10-hover"');
  const cards = [];
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i];
    const a = c.match(/<a\b([^>]*\bclass="bn"[^>]*)>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const href = a[1].match(/href="([^"]+)"/);
    const bt = c.match(/Business Type\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/);
    const ad = c.match(/Address\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/);
    const deals = c.match(/<div class="taj gray">([\s\S]*?)<\/div>/);
    cards.push({
      name: cleanText(a[2]),
      profile_url: href ? new URL(href[1], BASE).href : '',
      business_type: bt ? cleanText(bt[1]) : '',
      address: ad ? cleanText(ad[1]) : '',
      deals_in: deals ? cleanText(deals[1]) : '',
      verified_member: c.includes('icon-verified'),
    });
  }
  return cards;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let firstUrl = '';
  try {
    const parts = words(keyword);
    if (!parts.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }
    const kept = parts.filter((w) => !LEGAL.has(w.toLowerCase()));
    const used = kept.length ? kept : parts;
    const term = used.join(' ');
    const core = used.map((w) => w.toLowerCase()).join('');

    const urlFor = (page) => {
      const u = new URL(BASE);
      u.searchParams.set('term', term);
      u.searchParams.set('srch_catg_ty', 'comp');
      if (page > 1) u.searchParams.set('pageno', String(page));
      return u.href;
    };
    firstUrl = urlFor(1);

    const matches = [];
    let totalPages = 1;
    let checked = 0;

    for (let page = 1; page <= MAX_PAGES && page <= totalPages; page++) {
      if (page > 1 && Date.now() - started > PAGE_BUDGET_MS) break;
      const url = urlFor(page);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const cards = parseCards(html);
      const totalM = html.match(/([\d,]+)\s+results?\./i);

      if (page === 1) {
        if (!cards.length) {
          if (/No results found/i.test(html)) {
            return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `No results found for "${term}"` };
          }
          if (/captcha|cf-chl|Just a moment|Access denied/i.test(html)) {
            return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: html.slice(0, 200) };
          }
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
        }
        if (!totalM) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
        }
        const total = parseInt(totalM[1].replace(/,/g, ''), 10);
        totalPages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)));
      }

      checked = page;
      for (const card of cards) {
        const cardCore = words(card.name).filter((w) => !LEGAL.has(w.toLowerCase())).map((w) => w.toLowerCase()).join('');
        if (cardCore && cardCore === core) matches.push(card);
      }
    }

    if (matches.length) {
      const partial = checked < totalPages ? `; read ${checked} of ${totalPages} result pages, the rest were not read` : '';
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${matches.length} listing(s) with this name${partial}. First: ${first.name} | ${first.address}`.slice(0, 500),
      };
    }
    if (checked < totalPages) {
      return {
        status: 'couldnt_check',
        reason: 'timeout',
        records: [],
        source_url: firstUrl,
        excerpt: `no exact name match on ${checked} of ${totalPages} result pages; the rest were not read in time`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `No listing named "${used.join(' ')}" on ${checked} result page(s) for "${term}"`,
    };
  } catch (err) {
    return fetchFail(err, firstUrl);
  }
}
