export const meta = {
  task: 'TH-thaicondo.or.th',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_page', 'listing_text'],
  canary: { found: 'ธนาคารกสิกรไทย จำกัด (มหาชน)', not_found: 'บริษัท ทดสอบไม่มีจริง จำกัด' },
};

const BASE = 'https://thaicondo.or.th';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9,th;q=0.8' };
const MAX_PAGES = 8;
const START_NEW_PAGE_UNTIL_MS = 30000; // a page starts only inside this window, so 30 s + 25 s fetch stays under 60 s

// Legal forms (Thai and English) and the head-office marker. Removed before comparing names.
const LEGAL = [
  /\(\s*สำนักงานใหญ่\s*\)/giu, /\(\s*มหาชน\s*\)/giu, /ห้างหุ้นส่วนจำกัด/giu, /บริษัท/giu, /มหาชน/giu, /จำกัด/giu,
  /บจก\.?/giu, /บมจ\.?/giu, /public\s+company\s+limited/giu, /company\s+limited/giu, /\bco\.?\s*,?\s*ltd\.?/giu,
  /\bltd\.?/giu, /\blimited\b/giu, /\bpcl\.?/giu, /\bplc\.?/giu, /\bcompany\b/giu, /\binc\.?/giu,
];

/** Comparison key: legal forms, punctuation, spaces and case removed. Thai vowel marks (\p{M}) are kept. */
function nameKey(name) {
  let s = String(name || '').normalize('NFC');
  for (const re of LEGAL) s = s.replace(re, ' ');
  return s.replace(/[^\p{L}\p{M}\p{N}]+/gu, '').toLowerCase();
}

/** The words sent to the site search: the name without legal forms. */
function searchTerms(name) {
  let s = String(name || '').normalize('NFC');
  for (const re of LEGAL) s = s.replace(re, ' ');
  return s.replace(/[(),.&"'\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function text(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function pageUrl(terms, page) {
  const q = encodeURIComponent(terms);
  return page === 1 ? `${BASE}/?s=${q}` : `${BASE}/page/${page}/?s=${q}`;
}

/** Member entries on one search-results page. News and other posts are skipped. */
function parseMembers(html) {
  const out = [];
  for (const a of html.match(/<article[\s\S]*?<\/article>/g) || []) {
    const h = a.match(/<h5[^>]*>([\s\S]*?)<\/h5>/);
    if (!h) continue;
    const link = h[1].match(/href="([^"]+)"/);
    if (!link || !/\/member\//.test(link[1])) continue;
    const ex = a.match(/<p[^>]*qodef-post-excerpt[^>]*>([\s\S]*?)<\/p>/);
    out.push({ name: text(h[1]), member_page: new URL(decode(link[1]), BASE).href, listing_text: ex ? text(ex[1]) : '' });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const terms = searchTerms(keyword);
    const want = nameKey(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name in the input' };
    }

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > START_NEW_PAGE_UNTIL_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: pageUrl(terms, page),
                 excerpt: `search for "${terms}" was still running after ${page - 1} pages` };
      }
      const url = pageUrl(terms, page);
      let res;
      try {
        res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url,
                 excerpt: String(err?.message || err).slice(0, 200) };
      }
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();
      if (!/Search results for/i.test(html)) {
        if (/captcha|challenge-platform|cf-chl|Just a moment/i.test(html)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text(html).slice(0, 300) };
      }

      const articles = html.match(/<article[\s\S]*?<\/article>/g) || [];
      const matches = parseMembers(html).filter((m) => nameKey(m.name) === want);
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches.map((m) => ({ name: m.name, member_page: m.member_page, listing_text: m.listing_text })),
          source_url: url,
          excerpt: `${matches[0].name} | ${matches[0].listing_text}`.slice(0, 300),
        };
      }

      // More result pages exist only when the site links to the next one.
      const hasNext = html.includes(`/page/${page + 1}/?s=`);
      if (articles.length === 0 || !hasNext) {
        return {
          status: 'not_found',
          reason: '',
          records: [],
          source_url: url,
          excerpt: articles.length === 0 ? `No posts were found for "${terms}"` : `No member named "${terms}" in ${page} result page(s)`,
        };
      }
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl(terms, MAX_PAGES),
             excerpt: `search for "${terms}" has more than ${MAX_PAGES} result pages; not all checked` };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `${BASE}/?s=${encodeURIComponent(String(keyword || ''))}`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
