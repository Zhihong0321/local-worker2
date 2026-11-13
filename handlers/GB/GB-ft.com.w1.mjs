export const meta = {
  task: 'GB-ft.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'symbol', 'exchange', 'country', 'primary', 'tearsheet_url'],
  canary: { found: 'Tesco PLC', not_found: 'Zxqvorbel Holdings Ltd' },
};

// Financial Times market data search (markets.ft.com). It lists LISTED securities only (companies that trade on an
// exchange), so a company that is not listed anywhere is not_found here. www.ft.com itself answers 403 to automated
// clients and is not used.
const BASE = 'https://markets.ft.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['plc', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co',
  'company', 'gmbh', 'ag', 'sa', 'nv', 'se', 'bv', 'ab', 'spa', 'srl', 'pty', 'bhd', 'sdn', 'pte']);

/** Lower-case word tokens (Unicode aware, accents removed). */
function tokens(str) {
  return (str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Name tokens with trailing legal-form words removed: "TESCO PLC" -> ["tesco"]. */
function coreTokens(str) {
  const t = tokens(str);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t;
}

function decodeEntities(s) {
  const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return s
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Returns null when the page has no results table, otherwise one row per listing. */
function parseRows(html) {
  const tables = html.match(/<table[^>]*mod-ui-table[\s\S]*?<\/table>/gi) || [];
  const table = tables.find((t) => /<th[^>]*>\s*Company\s*<\/th>/i.test(t));
  if (!table) return null;
  const rows = [];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = tr.match(/<td[\s\S]*?<\/td>/gi);
    if (!cells || cells.length < 4) continue;
    const link = cells[0].match(/<a[^>]*href="([^"]*\/data\/equities\/tearsheet[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const exchangeHtml = cells[2];
    rows.push({
      name: cleanText(link[2]),
      tearsheet_url: new URL(decodeEntities(link[1]), BASE).href,
      symbol: cleanText(cells[1]),
      exchange: cleanText(exchangeHtml.replace(/<span[^>]*primary-tag[^>]*>[\s\S]*?<\/span>/i, '')),
      primary: /primary-tag/i.test(exchangeHtml),
      country: cleanText(cells[3]),
    });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Give the HTTP socket a moment to close before the runner exits: on Windows, Node 24 aborts with
  // "Assertion failed: UV_HANDLE_CLOSING" when the process exits while the socket is still closing.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return answer;
}

async function search(keyword) {
  const name = coreTokens(keyword);
  if (name.length === 0) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
  }
  const searchUrl = `${BASE}/data/search?query=${encodeURIComponent(name.join(' '))}`;
  // A plain timer that is cleared when done (AbortSignal.timeout leaves a live timer behind, which crashes the worker's exit).
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('the request did not finish in 25 s')), 25000);
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: ctl.signal,
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();

    const rows = parseRows(html);
    if (rows === null) {
      // No results table. A normal empty answer still shows the search form; anything else is not what we expect.
      if (/Search for a security/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
          excerpt: `No listed security matches "${keyword}"` };
      }
      if (/captcha|cf-chl|just a moment|verify you are human/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }
    if (rows.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: 'results table has no rows' };
    }

    // Match the company, not similar words: same name after case, punctuation and legal form are removed.
    const key = name.join('');
    const matches = rows
      .filter((r) => coreTokens(r.name).join('') === key)
      .sort((a, b) => Number(b.primary) - Number(a.primary));

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `No listed security matches "${keyword}" among ${rows.length} search results` };
    }
    return {
      status: 'found',
      reason: '',
      records: matches.map(({ name: n, symbol, exchange, country, primary, tearsheet_url }) =>
        ({ name: n, symbol, exchange, country, primary, tearsheet_url })),
      source_url: searchUrl,
      excerpt: matches.map((m) => `${m.name} | ${m.symbol} | ${m.exchange} | ${m.country}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = ctl.signal.aborted;
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}
