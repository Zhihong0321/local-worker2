export const meta = { task: 'AE-argaam.com', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'ticker', 'market', 'company_id', 'url'],
  canary: { found: 'أبوظبي التجاري', not_found: 'شركة تجريبية غير مدرجة' } };

// Argaam's UAE edition lists every company on ADX and DFM on one server-rendered page.
const LIST_URL = 'https://www.argaam.com/ae-ar/markets/dfm/companies-share-price';
const SITE = 'https://www.argaam.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words, removed before comparing (Arabic ones are written without dots after normalising).
const LEGAL = new Set(['pjsc', 'psc', 'plc', 'llc', 'fzllc', 'fzco', 'ltd', 'limited', 'inc', 'bhd', 'sdn', 'co', 'company',
  'شمع', 'شذمم', 'ذمم', 'شمح', 'شمخ', 'ششو']);
// Generic leading words the site leaves out ("بنك أبوظبي التجاري" is written "أبوظبي التجاري").
const LEADING = new Set(['بنك', 'مصرف', 'شركه']);
// A real page has about 171 companies; far fewer means the page changed.
const MIN_LISTED = 100;

function words(s) {
  return String(s || '').normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')   // harakat and tatweel
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .toLowerCase().replace(/\./g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Comparison key: no case, punctuation, spaces, legal form or leading generic word. */
function key(s) {
  const w = words(s);
  while (w.length > 1 && LEADING.has(w[0])) w.shift();
  return w.filter((t) => !LEGAL.has(t)).join('');
}

function parseList(html) {
  const byId = new Map();
  const re = /<a rel-cid="(\d+)" href="(\/ae-ar\/companies\/(adx|dfm)\/([^"\/]+)\/overview)">([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (byId.has(id)) continue;
    const text = m[5].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();   // e.g. "ADCB.AD - أبوظبي التجاري"
    const dash = text.indexOf(' - ');
    byId.set(id, {
      company_id: id,
      ticker: dash >= 0 ? text.slice(0, dash).trim() : '',
      name: (dash >= 0 ? text.slice(dash + 3) : text).trim(),
      market: m[3].toUpperCase(),
      slug: m[4],
      url: SITE + m[2],
    });
  }
  return [...byId.values()];
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  try {
    const kwKey = key(kw);
    if (!kwKey) return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const listed = parseList(html);
    if (listed.length < MIN_LISTED) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: `only ${listed.length} company links found on the list page` };
    }

    // Same normalised name as the site's Arabic name, or as the English name in the company's web address.
    const hits = listed.filter((c) => key(c.name) === kwKey || key(c.slug.replace(/-/g, ' ')) === kwKey);
    if (hits.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No match for "${kw}" among ${listed.length} companies listed on Argaam UAE (ADX and DFM)` };
    }
    return {
      status: 'found',
      reason: '',
      records: hits.map((c) => ({ name: c.name, ticker: c.ticker, market: c.market, company_id: c.company_id, url: c.url })),
      source_url: hits[0].url,
      excerpt: hits.map((c) => `${c.ticker} - ${c.name} (${c.market})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
