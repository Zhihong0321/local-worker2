export const meta = {
  task: 'MY-iscb.cybersecurity.my',
  want: 'w1',
  tier: 2,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'product', 'certificate_no', 'assurance_level', 'certificate_date', 'expiry_date', 'recognized_by', 'status'],
  canary: { found: 'HumanCard Technology Sdn Bhd', not_found: 'Dezeno' },
  pdf: false,
};

const BASE = 'https://iscb.cybersecurity.my/index.php/certification/product-certification/mycc/';
const CURRENT = BASE + 'certified-products-and-systems-5';
const ARCHIVED = BASE + 'archived-certified-products-and-systems';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STOP = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'the', 'and', 'inc', 'incorporated', 'ltd', 'limited', 'co', 'company', 'corporation', 'corp', 'plc', 'llc', 'pte', 'of', 'a', 'an']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  return String(s || '')
    .replace(/&amp;/g, ' & ')
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s) {
  return norm(s)
    .replace(/&/g, ' ')
    .split(' ')
    .filter((t) => t && !STOP.has(t));
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status + ' for ' + url);
    e.code = 'http_error';
    throw e;
  }
  return { html: await res.text(), url: res.url || url };
}

function looksLikeRegister(html) {
  // Markers the script relies on: the directory table and its column headers.
  return (
    /class="[^"]*directoryTable[^"]*"/i.test(html) &&
    /Certificate\s*No/i.test(html) &&
    /Product\s*Sponsor\s*\/\s*Developer/i.test(html) &&
    /directoryTableContainer/i.test(html)
  );
}

function textOf(fragment) {
  return String(fragment || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRows(html) {
  const tbody = html.split(/<tbody[^>]*>/i)[1] || '';
  const body = tbody.split(/<\/tbody>/i)[0] || '';
  const chunks = body.split(/<tr[^>]*>/i).slice(1);
  const rows = [];
  for (const chunk of chunks) {
    const tr = chunk.split(/<\/tr>/i)[0];
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 7) continue;
    rows.push({
      certificate_no: textOf(cells[0]),
      name: textOf(cells[1]),
      assurance_level: textOf(cells[2]),
      product: textOf(cells[3]),
      certificate_date: textOf(cells[4]),
      expiry_date: textOf(cells[5]),
      recognized_by: textOf(cells[6]),
    });
  }
  return rows;
}

function matches(row, wantTokens) {
  if (!wantTokens.length) return false;
  const hay = ' ' + norm(row.name + ' ' + row.product) + ' ';
  return wantTokens.every((t) => hay.includes(' ' + t));
}

async function readList(url, status) {
  const page = await get(url + '?limit=500');
  if (!looksLikeRegister(page.html)) {
    const e = new Error('register table markers missing on ' + url);
    e.code = 'layout_changed';
    throw e;
  }
  const rows = parseRows(page.html);
  if (!rows.length) {
    const e = new Error('register table is empty on ' + url);
    e.code = 'layout_changed';
    throw e;
  }
  for (const r of rows) r.status = status;
  return { rows, source_url: page.url };
}

function recordLine(r) {
  return `${r.certificate_no} | ${r.name} | ${r.assurance_level} | ${r.product} | ${r.certificate_date} - ${r.expiry_date} | ${r.recognized_by}`;
}

export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const wantTokens = tokens(kw);
  if (!wantTokens.length) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: CURRENT, excerpt: 'empty company name' };
  }

  try {
    const cur = await readList(CURRENT, 'certified');
    let hits = cur.rows.filter((r) => matches(r, wantTokens));
    let source = cur.source_url;

    if (!hits.length) {
      await sleep(1100);
      const arch = await readList(ARCHIVED, 'archived');
      hits = arch.rows.filter((r) => matches(r, wantTokens));
      source = arch.source_url;
      if (!hits.length) {
        return {
          status: 'not_found',
          reason: '',
          records: [],
          source_url: source,
          excerpt:
            `Read the MyCC register: ${cur.rows.length} certified products and ${arch.rows.length} archived certified products, ` +
            `no row names "${kw}".`,
        };
      }
    }

    return {
      status: 'found',
      reason: '',
      records: hits,
      source_url: source,
      excerpt: hits.map(recordLine).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const reason = err && err.code === 'layout_changed' ? 'layout_changed' : err && err.code === 'http_error' ? 'http_error' : 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: CURRENT,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
