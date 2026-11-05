// Official AEO roll is one static HTML table on /list-of-aeo/ (client-side paging only).
export const meta = {
  task: 'MY-aeo.customs.gov.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['no', 'aeo_id', 'mra_aeo_id', 'name', 'scope', 'effective_date'],
  canary: { found: 'EASTBOND LOGISTICS SDN BHD', not_found: 'DNE Logistics' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const PAGE = 'https://aeo.customs.gov.my/list-of-aeo/';

const STOP = new Set(['SDN', 'BHD', 'MALAYSIA', 'MALAYSIAN', 'THE', 'AND', 'COMPANY']);

let cache = null;
let cacheAt = 0;

function couldnt(reason, excerpt) {
  return {
    status: 'couldnt_check',
    reason,
    records: [],
    source_url: PAGE,
    excerpt: String(excerpt || '').replace(/\s+/g, ' ').slice(0, 500),
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function norm(s) {
  return decodeEntities(s)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\b(SDN\.?\s*BHD\.?|SENDIRIAN BERHAD|BERHAD|BHD\.?|PLT\.?)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
}

function wholeWord(hay, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc + '\\b').test(hay);
}

function matches(keyword, title) {
  const a = norm(keyword);
  const b = norm(title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 5 && (b.includes(a) || (b.length >= 5 && a.includes(b)))) return true;
  const ta = tokens(keyword);
  if (!ta.length) return false;
  if (!ta.every((t) => wholeWord(b, t))) return false;
  if (ta.length >= 2) return true;
  return ta[0].length >= 4;
}

function parseTable(html) {
  const table = html.match(/<table class="ea-advanced-data-table[^"]*"[\s\S]*?<\/table>/i);
  if (!table) return { error: 'AEO table missing' };
  const head = table[0];
  if (!head.includes('>COMPANY NAME<') || !head.includes('>AEO ID<') || !head.includes('>EFFECTIVE DATE<')) {
    return { error: 'AEO table headers changed' };
  }
  const body = head.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!body) return { error: 'AEO tbody missing' };
  const records = [];
  for (const tr of body[1].matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      decodeEntities(c[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    );
    if (cells.length < 6 || !cells[3]) continue;
    records.push({
      no: cells[0],
      aeo_id: cells[1],
      mra_aeo_id: cells[2],
      name: cells[3],
      scope: cells[4],
      effective_date: cells[5],
    });
  }
  if (records.length < 1) return { error: 'AEO table has no company rows' };
  return { records };
}

async function load() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  const res = await fetch(PAGE, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const head = text.slice(0, 600);
  if (
    res.status === 401 || res.status === 403 || res.status === 429 ||
    /cf-browser-verification|just a moment|captcha|attention required/i.test(head)
  ) {
    const err = new Error('blocked');
    err.reason = 'blocked';
    err.excerpt = 'HTTP ' + res.status + ' ' + head;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.reason = 'http_error';
    err.excerpt = 'HTTP ' + res.status;
    throw err;
  }
  if (!/List of AEO/i.test(text)) {
    const err = new Error('title missing');
    err.reason = 'layout_changed';
    err.excerpt = head;
    throw err;
  }
  const parsed = parseTable(text);
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.reason = 'layout_changed';
    err.excerpt = parsed.error;
    throw err;
  }
  cache = parsed.records;
  cacheAt = Date.now();
  return cache;
}

export default async function lookup(keyword) {
  try {
    const q = String(keyword ?? '').trim();
    if (!q) return couldnt('other', 'empty keyword');
    if (!norm(q)) return couldnt('other', 'keyword has no distinctive name');
    const all = await load();
    const hits = all.filter((row) => matches(q, row.name));
    if (!hits.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: 'No AEO company name matched "' + q.slice(0, 160) + '" among ' + all.length + ' rows on the List of AEO.',
      };
    }
    const row = hits[0];
    return {
      status: 'found',
      reason: '',
      records: hits,
      source_url: PAGE,
      excerpt: [row.no, row.aeo_id, row.mra_aeo_id, row.name, row.scope, row.effective_date].join(' | ').slice(0, 500),
    };
  } catch (err) {
    const reason = err?.reason || (/timeout|aborted|ETIMEDOUT/i.test(String(err?.message || err)) ? 'timeout' : 'other');
    return couldnt(reason, err?.excerpt || err?.message || err);
  }
}
