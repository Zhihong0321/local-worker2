export const meta = {
  task: 'CH-creditreform.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'crefo_id', 'status', 'street', 'zip', 'city', 'branch'],
  canary: { found: 'Nestlé Suisse S.A.', not_found: 'Zyxqwv Phantomfirma Nichtexistent GmbH' },
};

// creditreform.ch's "Suche im CrediWEB" box opens this public company list (names and addresses, no login).
const BASE = 'https://www.crediweb.ch/Search/GetSearchResult';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
};
const MAX_PAGES = 6;
// Legal forms, longest first so the longest suffix is removed first.
const LEGAL_WORDS = [
  'enliquidation', 'zweigniederlassung', 'succursale', 'liquidation', 'filiale', 'ltda', 'gmbh', 'sagl', 'plc', 'llc',
  'ltd', 'inc', 'sas', 'sarl', 'srl', 'spa', 'kg', 'rl', 'ag', 'sa',
].sort((a, b) => b.length - a.length);

function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Names compare equal when case, accents, punctuation, spaces and legal form are ignored. */
function normalize(name) {
  let s = fold(name).replace(/[^\p{L}\p{N}]/gu, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of LEGAL_WORDS) {
      if (s.length - w.length >= 3 && s.endsWith(w)) { s = s.slice(0, -w.length); changed = true; }
    }
  }
  return s;
}

/** The keyword without trailing legal-form words, e.g. "Nestlé Suisse S.A." -> "Nestlé Suisse". */
function coreName(keyword) {
  const tokens = keyword.trim().split(/\s+/);
  while (tokens.length > 1 && LEGAL_WORDS.includes(fold(tokens[tokens.length - 1]).replace(/[^\p{L}]/gu, ''))) {
    tokens.pop();
  }
  return tokens.join(' ');
}

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&#(\d+);/g, (m, n) => (+n <= 0x10ffff ? String.fromCodePoint(+n) : m))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' '));
}

/** One object per result row on a results page. */
function parseRows(html) {
  const out = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const nameCell = tr.match(/<td class="results-column-name"[\s\S]*?<\/td>/);
    const span = nameCell && nameCell[0].match(/class="span-archive-name"[^>]*>([\s\S]*?)<\/span>/);
    if (!span) continue;
    const name = clean(span[1]);
    const info = tr.match(/crefoid="(\d+)"/);
    const addr = tr.match(/<span class='mainAdress'>([\s\S]*?)<\/span>/);
    const zipCity = addr ? clean((addr[1].match(/<b>([\s\S]*?)<\/b>/) || [])[1]) : '';
    const street = addr
      ? clean(addr[1].replace(/<b>[\s\S]*?<\/b>/, '')).replace(/^,\s*/, '').replace(/[\s,]+$/, '')
      : '';
    const zipMatch = zipCity.match(/^(\S+)\s+(.+)$/);
    out.push({
      name,
      crefo_id: info ? info[1] : '',
      status: /inaktiv|geloescht/i.test(nameCell[0]) ? 'inactive' : 'active',
      street,
      zip: zipMatch ? zipMatch[1] : '',
      city: zipMatch ? zipMatch[2] : zipCity,
      branch: /succursale|zweigniederlassung|filiale|branch/i.test(name),
    });
  }
  return out;
}

function parseTotal(html) {
  if (/keine Treffer gefunden/i.test(html)) return 0;
  const m = html.match(/(\d+)\s+Ergebnisse/);
  return m ? Number(m[1]) : null;
}

// The site sends anonymous clients that search too often to /Error/SecurityWarning ("search restricted to members").
// Its "0 results" answer during that restriction is not a real not_found, so the redirect is read as blocked.
const RESTRICTED = /Missbrauch der Suchfunktion|Suchfunktion eingeschr/i;

// Requests go one at a time with a short pause, so the handler never sends a burst that looks like search abuse.
const GAP_MS = 1500;
let lastRequestAt = 0;

async function get(url, depth = 0) {
  const wait = lastRequestAt + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(25000) });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/SecurityWarning/i.test(loc)) return { blocked: true, code: `redirect to ${loc}` };
    if (depth >= 2 || !loc) return { code: res.status };
    return get(new URL(loc, url).href, depth + 1);
  }
  if (res.status === 403 || res.status === 429) return { blocked: true, code: res.status };
  if (!res.ok) return { code: res.status };
  const html = await res.text();
  if (RESTRICTED.test(html)) return { blocked: true, code: 'search restricted page' };
  return { code: res.status, html };
}

/** Runs one search and reads every results page it needs. Returns { url, rows, total, truncated } or { fail }. */
async function searchAll(query) {
  const url = `${BASE}?what=${encodeURIComponent(query)}&where=`;
  const first = await get(url);
  if (first.blocked) return { fail: { reason: 'blocked', url, excerpt: String(first.code) } };
  if (first.code !== 200) return { fail: { reason: 'http_error', url, excerpt: `HTTP ${first.code}` } };

  const total = parseTotal(first.html);
  if (total === null) {
    if (/captcha|zugriff verweigert|access denied|too many requests/i.test(first.html)) {
      return { fail: { reason: 'blocked', url, excerpt: clean(first.html).slice(0, 300) } };
    }
    if (/id="UserName"/.test(first.html)) {
      return { fail: { reason: 'blocked', url, excerpt: 'login form shown instead of results' } };
    }
    return { fail: { reason: 'layout_changed', url, excerpt: clean(first.html).slice(0, 300) } };
  }
  if (total === 0) return { url, rows: [], total: 0, truncated: false };

  const rows = parseRows(first.html);
  if (!rows.length) return { fail: { reason: 'layout_changed', url, excerpt: 'results count shown but no result rows' } };

  const pages = Math.ceil(total / rows.length);
  const last = Math.min(pages, MAX_PAGES);
  const rest = [];
  for (let page = 2; page <= last; page++) rest.push(await get(`${url}&page=${page}`));
  for (const r of rest) {
    if (r.blocked) return { fail: { reason: 'blocked', url, excerpt: String(r.code) } };
    if (r.code !== 200) return { fail: { reason: 'http_error', url, excerpt: `HTTP ${r.code}` } };
    rows.push(...parseRows(r.html));
  }
  return { url, rows, total, truncated: pages > MAX_PAGES };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  try {
    const key = normalize(name);
    if (key.length < 2) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'name too short to match' };
    }

    // Search the name as typed; if it has a legal form, also search the bare name (the site's fuzzy search may rank differently).
    const core = coreName(name);
    const queries = core && core !== name ? [name, core] : [name];
    const results = [];
    for (const query of queries) results.push(await searchAll(query));

    const byId = new Map();
    let truncated = false;
    for (const r of results) {
      if (!r.rows) continue;
      truncated = truncated || r.truncated;
      for (const row of r.rows) byId.set(row.crefo_id || row.name, row);
    }
    const matches = [...byId.values()].filter((row) => normalize(row.name) === key);
    const ok = results.find((r) => r.url);
    const sourceUrl = ok ? ok.url : BASE;

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: matches.map((m) => `${m.name}, ${m.zip} ${m.city}`).join(' | ').slice(0, 500),
      };
    }

    const failed = results.find((r) => r.fail);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.fail.reason, records: [], source_url: failed.fail.url, excerpt: failed.fail.excerpt };
    }
    if (truncated) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: sourceUrl,
        excerpt: `more than ${MAX_PAGES} result pages; no exact name match in the pages read`,
      };
    }
    const total = ok ? ok.total : 0;
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `${total} search results for "${name}", none with this name`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: BASE,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
