export const meta = { task: 'NZ-nzx.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'code', 'company_id', 'markets', 'address', 'country_code', 'website', 'first_listed', 'auditor', 'share_registry'],
  canary: { found: 'Fisher & Paykel Healthcare Corporation Limited', not_found: 'Te Kokiri Hapu Limited' } };

// NZX publishes its listed issuers on two market pages, each a server-rendered table with one link per issuer:
// /markets/NZSX (Main Board, equities) and /markets/NZDX (Debt Market). Each company page embeds its details as JSON.
const BASE = 'https://www.nzx.com';
const MARKETS = ['NZSX', 'NZDX'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_SUFFIX = new Set(['limited', 'ltd', 'incorporated', 'inc']);
const MIN_ISSUERS = 20;      // the real lists hold well over 100 issuers each; fewer means the page is not the list
const LATE_AFTER_MS = 30000; // after this, skip optional reads so the whole call stays under 60 s

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return m; }
  });
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare names: case, punctuation, "&" = "and", a bracketed suffix and the legal form are ignored. */
function normalizeName(name) {
  const s = cleanText(name).toLowerCase().replace(/&/g, ' and ').replace(/\([^)]*\)/g, ' ');
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function get(url) {
  return fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-NZ,en;q=0.8',
    },
  });
}

function failure(e) {
  const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
  return { reason: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) };
}

/** Reads one market list. Returns { ok: true, issuers: Map(code -> name) } or { ok: false, reason, excerpt }. */
async function readMarket(market) {
  const url = `${BASE}/markets/${market}`;
  try {
    const res = await get(url);
    if (res.status === 403 || res.status === 429) return { ok: false, url, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, url, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    const issuers = new Map();
    const re = /<a\b[^>]*\bhref="\/companies\/([A-Za-z0-9]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      const name = cleanText(m[2]);
      if (name && !issuers.has(m[1])) issuers.set(m[1], name);
    }
    if (issuers.size >= MIN_ISSUERS) return { ok: true, market, url, issuers };
    if (/cf-chl|challenge-platform|Just a moment|captcha|access denied/i.test(html)) {
      return { ok: false, url, reason: 'blocked', excerpt: 'bot check or captcha page instead of the list' };
    }
    return { ok: false, url, reason: 'layout_changed', excerpt: cleanText(html).slice(0, 300) };
  } catch (e) {
    return { ok: false, url, ...failure(e) };
  }
}

/** Reads one company page. Returns a record, or null with a note when the page could not be read. */
async function readCompany(code, listName, markets) {
  const url = `${BASE}/companies/${code}`;
  const fallback = { name: listName, code, markets, source: url };
  try {
    const res = await get(url);
    if (!res.ok) return { record: fallback, note: `company page HTTP ${res.status}` };
    const html = await res.text();
    const block = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!block) return { record: fallback, note: 'company page has no data block' };
    const pp = JSON.parse(block[1]).props?.pageProps || {};
    const q = {};
    for (const item of pp.dehydratedState?.queries || []) {
      if (item?.queryKey?.[0] === 'company') q[item.queryKey[1]] = item.state?.data || {};
    }
    const contact = q.contact || {};
    const summary = q.summary || {};
    const instruments = Object.values(pp.initialInstrumentData?.instruments || {});
    const record = {
      name: pp.companyName || listName,
      code: pp.companyCode || code,
      company_id: pp.companyId || '',
      markets: markets,
      address: contact.rawAddress || '',
      country_code: contact.countryCode || '',
      website: contact.websiteURL || '',
      first_listed: summary.firstListedDate || '',
      auditor: summary.auditor || '',
      share_registry: summary.primaryRegistry || '',
    };
    if (instruments.length) record.instruments = [...new Set(instruments.map((i) => i.marketType).filter(Boolean))];
    return { record, source: url };
  } catch (e) {
    return { record: fallback, note: `company page not read: ${failure(e).excerpt}` };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const late = () => Date.now() - started > LATE_AFTER_MS;
  try {
    const want = normalizeName(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    // Both lists are needed for a not_found. The second one is skipped only when time is short.
    const checks = [await readMarket(MARKETS[0])];
    checks.push(late()
      ? { ok: false, market: MARKETS[1], url: `${BASE}/markets/${MARKETS[1]}`, reason: 'timeout', excerpt: 'not read: time budget used' }
      : { ...(await readMarket(MARKETS[1])), market: MARKETS[1] });

    const hits = new Map(); // code -> { name, markets }
    for (const c of checks) {
      if (!c.ok) continue;
      for (const [code, listName] of c.issuers) {
        if (normalizeName(listName) !== want) continue;
        if (!hits.has(code)) hits.set(code, { name: listName, markets: [] });
        hits.get(code).markets.push(c.market);
      }
    }

    if (hits.size > 0) {
      const records = [];
      const notes = [];
      let sourceUrl = `${BASE}/markets/${MARKETS[0]}`;
      for (const [code, hit] of hits) {
        if (late()) {
          records.push({ name: hit.name, code, markets: hit.markets, source: `${BASE}/markets` });
          notes.push(`${code}: company page not read (time budget)`);
          continue;
        }
        const r = await readCompany(code, hit.name, hit.markets);
        records.push(r.record);
        if (r.note) notes.push(`${code}: ${r.note}`);
        if (r.source) sourceUrl = r.source;
      }
      const unread = checks.filter((c) => !c.ok).map((c) => `${c.market} not read (${c.reason})`);
      const firstHit = [...hits.values()][0];
      return {
        status: 'found',
        reason: '',
        records: records.map(({ source, ...rest }) => rest),
        source_url: sourceUrl,
        excerpt: `NZX list entry "${firstHit.name}" on ${firstHit.markets.join(', ')}` +
          (notes.length ? `; ${notes.join('; ')}` : '') + (unread.length ? `; ${unread.join('; ')}` : ''),
      };
    }

    const bad = checks.find((c) => !c.ok);
    if (bad) {
      return {
        status: 'couldnt_check',
        reason: bad.reason,
        records: [],
        source_url: bad.url,
        excerpt: `${bad.market}: ${bad.excerpt}`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${BASE}/markets/${MARKETS[0]}`,
      excerpt: `No match for "${keyword}" in the NZX issuer lists: NZSX ${checks[0].issuers.size} issuers, NZDX ${checks[1].issuers.size} issuers`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
