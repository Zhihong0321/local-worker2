export const meta = {
  task: 'AU-search.ipaustralia.gov.au',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'trade_mark_number', 'trade_mark_words', 'classes', 'status', 'owners', 'record_url'],
  canary: { found: 'Fresh Generation Uk Limited', not_found: 'Zqxwvb Holdings Pty Ltd' },
};

// Quick search results page: server-rendered HTML, 100 trade mark rows per page (p=0 is page 1).
const BASE = 'https://search.ipaustralia.gov.au/trademarks/search/quick/result';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10;      // at most 1,000 rows read per lookup
const BUDGET_MS = 45000;   // stop reading more pages well before the 60 s limit
const LEGAL_FORMS = new Set(['pty', 'ltd', 'limited', 'sdn', 'bhd', 'inc', 'incorporated', 'llc', 'llp', 'lp',
  'co', 'company', 'corp', 'corporation', 'plc', 'gmbh', 'pte', 'pvt', 'ag', 'sa', 'nv', 'bv']);
const BLOCK_RE = /captcha|access denied|verify you are (a )?human|unusual traffic/i;

function decode(s) {
  const cp = (n) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d{1,7});/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// The name without trailing legal-form words ("Pty Ltd", "Limited", "Sdn Bhd"), original case kept.
function legalCore(name) {
  const all = decode(name).replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  const words = all.slice();
  while (words.length > 0 && LEGAL_FORMS.has(words[words.length - 1].toLowerCase())) words.pop();
  return (words.length ? words : all).join(' ');
}

// Owner text as the site writes it, reduced to a comparison key: "Fresh Generation Uk Limited" -> "freshgenerationuk".
// "X Pty Ltd as trustee for Y" compares as "X Pty Ltd".
function matchKey(name) {
  const beforeTrustee = String(name).split(/\s+(?:as\s+trustees?|atf)\b/i)[0];
  return legalCore(beforeTrustee).toLowerCase().replace(/\s+/g, '');
}

function totalOf(html) {
  const m = html.match(/<h2 class="number qa-count">\s*([\d,\s]+?)\s*<\/h2>/);
  if (!m) return null;
  const n = Number(m[1].replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseRows(html, base) {
  const rows = [];
  for (const block of html.match(/<tbody\b[^>]*js-mark-record[\s\S]*?<\/tbody>/g) || []) {
    const id = (block.match(/data-mark-id="(\d+)"/) || [])[1] || '';
    const markUrl = (block.match(/data-markurl="([^"]+)"/) || [])[1] || '';
    const words = clean((block.match(/<td class="trademark words"[^>]*>([\s\S]*?)<\/td>/) || [])[1]);
    const classes = clean((block.match(/<td class="classes[^"]*"[^>]*>([\s\S]*?)<\/td>/) || [])[1]);
    const status = clean((block.match(/<td class="status"[^>]*>([\s\S]*?)<\/td>/) || [])[1]);
    const ownerDl = (block.match(/<dl class="list-of-definition goods-service owner-name">([\s\S]*?)<\/dl>/) || [])[1] || '';
    const owners = [...ownerDl.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => clean(m[1])).filter(Boolean);
    let record_url = '';
    try { record_url = markUrl ? new URL(decode(markUrl), base).href : ''; } catch (e) { record_url = ''; }
    rows.push({ trade_mark_number: id, trade_mark_words: words, classes, status, owners, record_url });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let searchUrl = '';
  try {
    const input = String(keyword || '').trim();
    const q = legalCore(input);
    if (!q) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }
    const wantKey = matchKey(input);
    searchUrl = `${BASE}?q=${encodeURIComponent(q)}`;

    const get = (url) => fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-AU,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });

    const first = await get(searchUrl);
    if (first.status === 403 || first.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${first.status}` };
    }
    if (!first.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${first.status}` };
    }
    const html0 = await first.text();
    const total = totalOf(html0);
    if (total === null) {
      if (BLOCK_RE.test(html0)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: clean(html0).slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: clean(html0).slice(0, 300) };
    }

    const records = [];
    const seen = new Set();
    let read = 0;
    let html = html0;
    for (let page = 0; ; page++) {
      if (page > 0) {
        if (read >= total || page >= MAX_PAGES || Date.now() - started > BUDGET_MS) break;
        const res = await get(`${searchUrl}&p=${page}`);
        if (res.status === 403 || res.status === 429) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status} on page ${page + 1}` };
        }
        if (!res.ok) {
          return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status} on page ${page + 1}` };
        }
        html = await res.text();
      }
      const rows = parseRows(html, searchUrl);
      if (page > 0 && rows.length === 0) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: `page ${page + 1} has no result rows` };
      }
      read += rows.length;
      for (const row of rows) {
        for (const owner of row.owners) {
          if (matchKey(owner) !== wantKey) continue;
          const key = `${row.trade_mark_number}|${owner}`;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push({ name: owner, trade_mark_number: row.trade_mark_number, trade_mark_words: row.trade_mark_words,
            classes: row.classes, status: row.status, owners: row.owners, record_url: row.record_url });
        }
      }
      if (records.length) break;
    }

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: `${records.length} trade mark record(s) list "${records[0].name}" as owner (${total} results for "${q}")`,
      };
    }
    if (total === 0 || read >= total) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: total === 0 ? `0 trade mark results for "${q}"` : `${total} results for "${q}", none lists "${input}" as owner`,
      };
    }
    return {
      status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
      excerpt: `read ${read} of ${total} results for "${q}" within the time limit; owner not among them`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
