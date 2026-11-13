export const meta = {
  task: 'JP-kigyolog.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'business', 'address', 'founded', 'representative', 'capital', 'company_url'],
  canary: { found: 'SHOWROOM株式会社', not_found: '株式会社ワンダーゼロネクストクオリア' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://kigyolog.com';
const MAX_CANDIDATES = 8;

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Japanese legal forms and brackets are dropped; the core name is compared.
function coreName(s) {
  let t = (s || '').normalize('NFKC');
  t = t.replace(/[（(][^）)]*[）)]/g, ' ');
  t = t.replace(/株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人/g, ' ');
  t = t.replace(/\b(co\.?\s*,?\s*ltd\.?|inc\.?|corp\.?|corporation|k\.k\.|kk)(?=\s|$)/gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return coreName(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

async function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function isBlockPage(html) {
  return /cf-chl|Just a moment\.\.\.|Attention Required|Access denied/i.test(html);
}

// Reads the 会社情報 table: label cell + value cell per row.
function parseCompany(html, url) {
  const start = html.indexOf('会社情報');
  if (start < 0) return null;
  const tableMatch = html.slice(start).match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return null;
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const map = {};
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((c) => cleanText(c));
    if (cells.length >= 2) map[cells[0]] = cells[1];
  }
  if (!map['会社名']) return null;
  return {
    name: map['会社名'],
    business: map['事業内容'] || '',
    address: map['所在地'] || '',
    founded: map['設立日'] || '',
    representative: map['代表'] || '',
    capital: map['資本金'] || '',
    company_url: url,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const input = String(keyword || '').trim();
    const query = coreName(input) || input;
    if (!norm(input)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no company name in the input' };
    }

    searchUrl = `${BASE}/search.php?q=${encodeURIComponent(query)}`;
    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (isBlockPage(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 200) };
    }
    if (!html.includes('検索結果')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    // Company profile pages are linked from the search results.
    const ids = [];
    for (const m of html.matchAll(/company\.php\?id=(\d+)/g)) {
      if (!ids.includes(m[1])) ids.push(m[1]);
      if (ids.length >= MAX_CANDIDATES) break;
    }

    if (ids.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `search for "${query}" returned no company profile`,
      };
    }

    const pages = await Promise.all(ids.map(async (id) => {
      const url = `${BASE}/company.php?id=${id}`;
      try {
        const r = await get(url);
        if (!r.ok) return { url, error: `HTTP ${r.status}`, code: r.status === 403 || r.status === 429 ? 'blocked' : 'http_error' };
        const body = await r.text();
        if (isBlockPage(body)) return { url, error: 'block page', code: 'blocked' };
        const rec = parseCompany(body, url);
        if (!rec) return { url, error: 'company table not found', code: 'layout_changed' };
        return { url, rec };
      } catch (e) {
        return { url, error: String(e?.message || e), code: 'other' };
      }
    }));

    const want = norm(input);
    const matches = pages.filter((p) => p.rec && norm(p.rec.name) === want).map((p) => p.rec);
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matches[0].company_url,
        excerpt: cleanText(`${matches[0].name} ${matches[0].address} ${matches[0].founded} ${matches[0].representative} ${matches[0].capital}`).slice(0, 500),
      };
    }

    // No match: only a clean "not there" if every candidate was read.
    const failed = pages.filter((p) => !p.rec);
    if (failed.length > 0) {
      const f = failed[0];
      return { status: 'couldnt_check', reason: f.code, records: [], source_url: f.url, excerpt: f.error };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `${ids.length} company profile(s) checked for "${query}", none with this name`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
