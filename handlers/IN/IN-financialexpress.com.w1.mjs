export const meta = {
  task: 'IN-financialexpress.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'share_price_url', 'index_page'],
  canary: { found: 'Infosys Ltd.', not_found: 'Zyrvantex Bharat Holdings Pvt Ltd' },
};

// Financial Express publishes an A-Z index of NSE/BSE listed companies (one plain HTML page per letter, plus "others").
// Companies whose name starts with "The" sit under the "t" page, so that page is always checked as well.
const BASE = 'https://www.financialexpress.com/market/stock-market-stats/stock-price-quotes';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_TAIL = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'plc', 'inc', 'co', 'company']);
const FAIL_ORDER = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparable form of a company name: case, accents, punctuation, "&"/"and", leading "The" and legal form removed. */
function nameKey(text) {
  const t = decode(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ');
  const toks = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (toks[0] === 'the') toks.shift();
  while (toks.length && LEGAL_TAIL.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

function hasNonLatinLetter(s) {
  return [...s].some((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch));
}

function parseEntries(html) {
  const out = new Map();
  const re = /<a\s[^>]*?href="(https:\/\/www\.financialexpress\.com\/market\/[^"]+?-share-price\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = decode(m[2]);
    if (name && !out.has(m[1])) out.set(m[1], name);
  }
  return [...out].map(([url, name]) => ({ url, name }));
}

async function fetchIndex(page) {
  const url = `${BASE}/${page}/`;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-IN,en;q=0.9',
        'connection': 'close', // no kept-alive socket left open when the worker process exits
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { url, fail: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { url, fail: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    const entries = parseEntries(html);
    if (!entries.length) {
      const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
      if (/captcha|just a moment|access denied|attention required|verify you are human/i.test(title)) {
        return { url, fail: 'blocked', detail: 'bot check page' };
      }
      return { url, fail: 'layout_changed', detail: `no company links on page; title: ${title}`.slice(0, 300) };
    }
    return { url, entries };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, fail: timeout ? 'timeout' : 'other', detail: String((err && err.message) || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const indexUrl = `${BASE}/`;
  try {
    const raw = String(keyword || '').trim();
    if (!raw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: indexUrl, excerpt: 'empty company name' };
    }
    if (hasNonLatinLetter(raw)) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: indexUrl,
        excerpt: 'name is not in Latin script; this site lists companies in English spelling only',
      };
    }
    const key = nameKey(raw);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: indexUrl, excerpt: 'no usable name after removing legal form' };
    }

    const letter = /^[a-z]/.test(key) ? key[0] : 'others';
    const pages = [...new Set([letter, 't'])];
    // Sequential on purpose: two parallel fetches trigger a libuv exit assertion on Windows Node 24.
    // Worst case is 2 x 25 s, which is inside the 60 s limit.
    const results = [];
    for (const page of pages) results.push(await fetchIndex(page));

    const matched = new Map(); // one record per share-price page, even when two index pages list it
    const similar = [];
    for (const r of results) {
      if (!r.entries) continue;
      for (const e of r.entries) {
        const ek = nameKey(e.name);
        if (ek === key) {
          if (!matched.has(e.url)) matched.set(e.url, { name: e.name, share_price_url: e.url, index_page: r.url });
        } else if (ek.length >= 6 && key.length >= 6 && (ek.includes(key) || key.includes(ek))) {
          similar.push(e.name);
        }
      }
    }
    const records = [...matched.values()];

    if (records.length) {
      return {
        status: 'found', reason: '', records,
        source_url: records[0].index_page,
        excerpt: `Listed on the site's company index: ${records.map((x) => x.name).join('; ')}`.slice(0, 500),
      };
    }

    const failed = results.filter((r) => r.fail).sort((a, b) => FAIL_ORDER.indexOf(a.fail) - FAIL_ORDER.indexOf(b.fail))[0];
    if (failed) {
      return {
        status: 'couldnt_check', reason: failed.fail, records: [], source_url: failed.url,
        excerpt: `${failed.detail}; checked ${pages.join(', ')}`.slice(0, 500),
      };
    }

    if (similar.length) {
      // Not the same name, but a close one is listed: the site may use another spelling, so do not claim "not listed".
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: results[0].url,
        excerpt: `no exact match; similar listed name(s), not confirmed: ${[...new Set(similar)].join('; ')}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found', reason: '', records: [], source_url: results[0].url,
      excerpt: `No exact match for "${raw}" on the company index pages checked (${pages.join(', ')})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check', reason: 'other', records: [], source_url: indexUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
