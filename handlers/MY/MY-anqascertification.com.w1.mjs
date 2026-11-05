export const meta = {
  task: 'MY-anqascertification.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'country', 'certificate_no', 'product', 'standard'],
  canary: { found: 'Aceon Manufacturing (M) Sdn. Bhd.', not_found: 'O2O Digital' },
};

const URL_LIST = 'https://anqascertification.com/certified-products/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SUFFIX = new Set([
  'sdn', 'bhd', 'berhad', 'sendirian', 'limited', 'ltd', 'inc', 'incorporated', 'co',
  'company', 'corp', 'corporation', 'enterprise', 'trading', 'group', 'holdings', 'plc',
  'llp', 'llc', 'the', 'and',
]);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function cellText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return decodeEntities(String(s))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function core(n) {
  const t = n.split(' ').filter(Boolean);
  while (t.length > 1 && SUFFIX.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

function parseRows(html) {
  const tb = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tb) return null;
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tb[1])) !== null) {
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(m[1])) !== null) cells.push(cellText(c[1]));
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

function excerptAround(text, idx) {
  const start = Math.max(0, idx - 200);
  return text.slice(start, start + 500).replace(/\s+/g, ' ').trim();
}

export default async function lookup(keyword) {
  let html;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    const res = await fetch(URL_LIST, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: res.status === 403 || res.status === 429 ? 'blocked' : 'http_error',
        records: [],
        source_url: URL_LIST,
        excerpt: `HTTP ${res.status}`,
      };
    }
    html = await res.text();
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: e && e.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: URL_LIST,
      excerpt: String((e && e.message) || e).slice(0, 300),
    };
  }

  // layout guard: the page must still be the TablePress certificate-holder table
  const hasTable = /id=["']tablepress-1["']/i.test(html);
  const hasHeader = /Certificate\s+Holder/i.test(html) && /Certificate\s+No\.?/i.test(html);
  const rows = parseRows(html);
  if (!hasTable || !hasHeader || !rows || rows.length < 100) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: URL_LIST,
      excerpt: `tablepress-1=${hasTable} header=${hasHeader} rows=${rows ? rows.length : 'none'}`.slice(0, 300),
    };
  }

  const qn = norm(keyword || '');
  const qc = core(qn);
  if (!qc || qc.length < 2) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: URL_LIST,
      excerpt: `empty or too-short keyword: ${JSON.stringify(keyword || '')}`,
    };
  }

  const records = [];
  for (const cells of rows) {
    const full = norm(cells[0]);
    const fc = core(full);
    const hit =
      (qc.length >= 3 && full.includes(qc)) ||
      (fc.length >= 4 && (qn.includes(fc) || qc.includes(fc) || fc === qc));
    if (hit) {
      records.push({
        name: cells[0],
        country: cells[1] || '',
        certificate_no: cells[2] || '',
        product: cells[3] || '',
        standard: cells[4] || '',
      });
    }
  }

  if (records.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: URL_LIST,
      excerpt: `certificate-holder table read (${rows.length} rows); no holder matching "${keyword}"`,
    };
  }

  const flat = records.map((r) => `${r.name} | ${r.country} | ${r.certificate_no} | ${r.product} | ${r.standard}`).join('\n');
  const idx = Math.max(0, flat.toLowerCase().indexOf(records[0].name.toLowerCase()));
  return {
    status: 'found',
    reason: '',
    records,
    source_url: URL_LIST,
    excerpt: excerptAround(flat, idx),
  };
}
