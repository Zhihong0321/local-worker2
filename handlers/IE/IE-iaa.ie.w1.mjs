export const meta = { task: 'IE-iaa.ie', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'trading_names', 'address', 'website', 'insolvency_protection', 'expiry_date', 'matched_on', 'matched_value'],
  canary: { found: 'Aer Lingus', not_found: 'Comhlacht Taistil Na Gealaí Teoranta' } };

// The IAA "Booking a Holiday? - Am I Protected?" page carries the whole register of licensed Irish travel agents and
// tour operators (one HTML table, class "agentsList", all rows in the page, no login, no search request).
const PAGE_URL = 'https://www.iaa.ie/travel-trade/consumer/booking-a-holiday---am-i-protected-';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// The register had 216 rows when this was written. Far fewer rows means the page layout changed, not that companies left.
const MIN_ROWS = 20;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", ndash: '-', mdash: '-' };
// Legal-form words that are dropped from the end of a name before comparing ("Ltd" = "Limited", "Teoranta" = Irish "Ltd").
const LEGAL = new Set(['limited', 'ltd', 'teoranta', 'teo', 'dac', 'designated', 'activity', 'company', 'plc', 'unlimited', 'ulc', 'uc',
  'sa', 'sas', 'sl', 'sau', 'srl', 'sarl', 'gmbh', 'ag', 'nv', 'bv', 'inc', 'llc', 'llp', 'ltda', 'spa', 'corp', 'co']);

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower case, no accents (Irish fada etc.), punctuation removed, "&" read as "and". */
function norm(s) {
  return decodeEntities(String(s || ''))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalised name with trailing legal-form words removed: "ACME TRADING, Ltd." -> "acme trading". */
function core(s) {
  const t = norm(s).split(' ').filter(Boolean);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** Every name a register row answers to: registered name, "formerly" name, "/" alternatives, parenthetical names. */
function aliasesOf(name) {
  const out = [name];
  for (const m of name.matchAll(/\(([^)]*)\)/g)) out.push(m[1].replace(/^\s*formerly\s+/i, ''));
  const outer = name.replace(/\([^)]*\)/g, ' ');
  out.push(outer);
  for (const part of outer.split('/')) out.push(part);
  return out;
}

function parseRows(html) {
  const tableMatch = html.match(/<table[^>]*class="[^"]*agentsList[^"]*"[\s\S]*?<\/table>/i);
  if (!tableMatch) return null;
  const rows = [];
  for (const row of tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const nameHtml = row.match(/<p[^>]*class="tName"[^>]*>([\s\S]*?)<\/p>/i);
    if (!nameHtml) continue; // header row
    const name = cleanText(nameHtml[1]);
    const addrHtml = (row.match(/<p[^>]*class="tAddress"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    const website = cleanText((addrHtml.match(/class="website"[^>]*>\s*Website:\s*<span>([\s\S]*?)<\/span>/i) || [])[1] || '');
    const address = cleanText(addrHtml.replace(/<span[^>]*class="(?:website|phone|fax|email)"[\s\S]*?<\/span>\s*<\/span>|<span[^>]*class="(?:website|phone|fax|email)"[\s\S]*?<\/span>/gi, ' '));
    const insolv = cleanText((row.match(/Insolvency Protection:\s*<\/strong>([\s\S]*?)\|/i) || [])[1] || '');
    const expiry = cleanText((row.match(/Expiry Date:\s*<\/strong>([\s\S]*?)<\/p>/i) || [])[1] || '');
    const tds = row.match(/<td[\s\S]*?<\/td>/gi) || [];
    const tradingNames = tds.length > 1
      ? tds[1].replace(/<\/?td[^>]*>/gi, '').split(/<br\s*\/?>/i).map(cleanText).filter(Boolean)
      : [];
    rows.push({ name, address, website, insolvency_protection: insolv, expiry_date: expiry, trading_names: tradingNames });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = core(keyword);
  try {
    const res = await fetch(PAGE_URL, {
      // Connection: close stops a keep-alive socket from being left open when the worker calls process.exit().
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const rows = parseRows(html);
    if (rows === null) {
      if (/captcha|cf-chl|just a moment|access denied/i.test(html.slice(0, 20000))) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: 'bot or captcha page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: 'no agentsList table on the page' };
    }
    if (rows.length < MIN_ROWS) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: `only ${rows.length} rows parsed` };
    }
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'no name left to search after removing the legal form' };
    }

    const records = [];
    for (const r of rows) {
      let matchedOn = '', matchedValue = '';
      for (const a of aliasesOf(r.name)) {
        if (core(a) && core(a) === kw) { matchedOn = 'registered name'; matchedValue = a; break; }
      }
      if (!matchedOn) {
        for (const t of r.trading_names) {
          for (const a of aliasesOf(t)) {
            if (core(a) && core(a) === kw) { matchedOn = 'trading name'; matchedValue = t; break; }
          }
          if (matchedOn) break;
        }
      }
      if (matchedOn) records.push({ ...r, matched_on: matchedOn, matched_value: matchedValue });
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
        excerpt: `Register page read: ${rows.length} listed businesses; no registered or trading name matches "${keyword}"` };
    }
    const first = records[0];
    return {
      status: 'found', reason: '', records, source_url: PAGE_URL,
      excerpt: `${first.name} | ${first.address} | Insolvency Protection: ${first.insolvency_protection} | Expiry Date: ${first.expiry_date}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
