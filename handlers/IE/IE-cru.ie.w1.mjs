export const meta = {
  task: 'IE-cru.ie',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'trading_name', 'domestic_electricity', 'domestic_gas', 'business_electricity', 'business_gas'],
  canary: { found: 'Electric Ireland', not_found: 'Cuideachta Fuinnimh Gaelach Teoranta' },
};

// CRU list of electricity and gas suppliers (server-rendered HTML table on one page).
const SOURCE_URL = 'https://www.cru.ie/en-ie/consumer-information/switch-supplier/energy-suppliers-in-ireland/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EXPECTED_HEADERS = [
  'domestic customer electricity',
  'domestic customer gas',
  'business customer electricity',
  'business customer gas',
];
// Legal-form words that do not change which company is meant (English and Irish).
const LEGAL_WORDS = new Set(['ltd', 'limited', 'dac', 'teo', 'teoranta', 'plc', 'unlimited', 'uc', 'cuideachta', 'company', 'co', 'inc', 'llc']);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cellText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a name: accents folded, case and punctuation removed, legal-form words removed. */
function fold(text) {
  const withTradingWord = String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // Irish fadas and other accents
    .replace(/\b(trading\s+as|t\s*\/\s*a|t\s+a)\b/gi, ' tradingas ');
  return withTradingWord
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_WORDS.has(w))
    .join('');
}

/** "Yuno Ltd trading as PrePayPower" -> legal "Yuno Ltd", trading "PrePayPower". */
function splitRowName(name) {
  const parts = name.split(/\s+(?:trading\s+as|t\/a)\s+/i);
  return { legal: parts[0].trim(), trading: (parts[1] || '').trim() };
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

async function run(keyword) {
  try {
    const query = String(keyword || '').trim();
    if (!query) return fail('other', SOURCE_URL, 'empty company name');

    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();

    if (res.status === 403 || res.status === 429) return fail('blocked', SOURCE_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', SOURCE_URL, `HTTP ${res.status}`);
    if (!/Domestic Customer Electricity/i.test(html) && /captcha|cf-chl|access denied|attention required/i.test(html)) {
      return fail('blocked', SOURCE_URL, 'bot check page');
    }

    // Find the supplier table and check its header is the one we expect.
    const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    const table = tables.find((t) => /Domestic Customer Electricity/i.test(t));
    if (!table) return fail('layout_changed', SOURCE_URL, 'no supplier table found: ' + cellText(html).slice(0, 200));

    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || [])
      .map((r) => (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(cellText));
    const header = (rows[0] || []).slice(1, 5).map((h) => h.toLowerCase());
    if (header.length !== 4 || header.some((h, i) => h !== EXPECTED_HEADERS[i])) {
      return fail('layout_changed', SOURCE_URL, 'unexpected table header: ' + JSON.stringify(rows[0] || []));
    }

    const suppliers = rows.slice(1).filter((c) => c.length >= 5 && c[0]);
    if (suppliers.length < 5) {
      return fail('layout_changed', SOURCE_URL, `only ${suppliers.length} supplier rows found`);
    }

    // Match the whole company name (not similar words): compare folded full name, legal part, trading part.
    const wanted = fold(query);
    const records = [];
    for (const cells of suppliers) {
      const name = cells[0];
      const { legal, trading } = splitRowName(name);
      const keys = [fold(name), fold(legal), trading ? fold(trading) : ''].filter(Boolean);
      if (!keys.includes(wanted)) continue;
      records.push({
        name,
        legal_name: legal,
        trading_name: trading,
        domestic_electricity: cells[1] === '✓',
        domestic_gas: cells[2] === '✓',
        business_electricity: cells[3] === '✓',
        business_gas: cells[4] === '✓',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SOURCE_URL,
        excerpt: `No supplier on the CRU list matches "${query}" (${suppliers.length} suppliers checked)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: SOURCE_URL,
      excerpt: records.map((r) => r.name).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SOURCE_URL, String(err?.message || err));
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause lets the HTTPS socket finish closing before the runner exits: on Windows, Node 24 otherwise
 * aborts on exit right after a fetch to this site (exit 127, "UV_HANDLE_CLOSING" assertion).
 */
export default async function lookup(keyword) {
  const out = await run(keyword);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}
