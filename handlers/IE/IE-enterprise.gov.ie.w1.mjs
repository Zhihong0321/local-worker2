export const meta = {
  task: 'IE-enterprise.gov.ie',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list_year', 'grand_total', 'monthly', 'list_url'],
  canary: { found: '2K Games Dublin Limited', not_found: 'Cuideachta Neamhliostaithe Teoranta' },
};

// Department of Enterprise, Trade and Employment: "Employment permits issued to companies" XLSX lists,
// linked from the Employment Permit Statistics publication pages for each year. The 2026 list runs from January
// to the end of the previous month. The file names differ per year, so each year's address is listed here.
const STATS_PAGE = 'https://enterprise.gov.ie/en/what-we-do/workplace-and-skills/employment-permits/statistics/';
const LISTS = [
  { year: '2026', url: 'https://enterprise.gov.ie/en/publications/publication-files/employment-permits-issued-to-companies-2026.xlsx' },
  { year: '2025', url: 'https://enterprise.gov.ie/en/publications/publication-files/permits-issued-to-companies-2025.xlsx' },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'unlimited', 'company', 'co', 'dac', 'clg', 'teoranta', 'plc', 'llp', 'ulc']);
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Normalised company key: case, punctuation, "&" and trailing legal form ignored. Must be equal to match. */
function nameKey(str) {
  const words = decodeEntities(str || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9À-ɏ ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** Reads the zip central directory and returns the two XML parts the list needs (sheet 1 and shared strings). */
function readZipParts(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  const parts = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name !== 'xl/worksheets/sheet1.xml' && name !== 'xl/sharedStrings.xml') continue;
    if (dv.getUint32(loff, true) !== 0x04034b50) throw new Error('bad zip entry');
    const start = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
    parts[name] = { method, data: bytes.subarray(start, start + csize) };
  }
  return parts;
}

async function partText(part) {
  let bytes = part.data;
  if (part.method === 8) {
    const stream = new Blob([part.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (part.method !== 0) {
    throw new Error('unsupported zip method ' + part.method);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Rows of cells: [{ col: 'A', text: '...' }, ...]. */
function readRows(sheetXml, shared) {
  const rows = [];
  for (const rm of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!ref) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      let text = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        text = v ? (shared[Number(v[1])] ?? '') : '';
      } else if (type === 'inlineStr') {
        text = decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        text = v ? decodeEntities(v[1]) : '';
      }
      cells.push({ col: ref[1], text: text.trim() });
    }
    rows.push(cells);
  }
  return rows;
}

/** Fetches one year's list and searches it. Never throws: returns { ok: true, ... } or { ok: false, reason, ... }. */
async function searchList(list, target) {
  try {
    const res = await fetch(list.url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', url: list.url, year: list.year, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: 'http_error', url: list.url, year: list.year, excerpt: `HTTP ${res.status}` };

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, reason: 'layout_changed', url: list.url, year: list.year, excerpt: 'not an XLSX file' };
    const parts = readZipParts(bytes);
    if (!parts['xl/worksheets/sheet1.xml']) return { ok: false, reason: 'layout_changed', url: list.url, year: list.year, excerpt: 'no sheet 1' };

    const shared = parts['xl/sharedStrings.xml']
      ? [...(await partText(parts['xl/sharedStrings.xml'])).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
          .map(m => decodeEntities([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')))
      : [];
    const rows = readRows(await partText(parts['xl/worksheets/sheet1.xml']), shared);

    // Header row: the first of the top rows that names months, the employer or the grand total.
    const headerIdx = rows.slice(0, 6).findIndex(r => r.some(c => MONTH.test(c.text) || /employer|grand total/i.test(c.text)));
    if (headerIdx < 0) return { ok: false, reason: 'layout_changed', url: list.url, year: list.year, excerpt: 'no header row found' };
    const header = {};
    for (const c of rows[headerIdx]) header[c.col] = c.text;
    const nameCol = Object.keys(header).find(col => /employer|company/i.test(header[col])) || 'A';
    const totalCol = Object.keys(header).find(col => /grand total/i.test(header[col])) || null;
    const monthCols = Object.keys(header).filter(col => col !== nameCol && MONTH.test(header[col]) && !/grand total/i.test(header[col]));

    let checked = 0;
    const matches = [];
    for (const row of rows.slice(headerIdx + 1)) {
      const nameCell = row.find(c => c.col === nameCol);
      const rowName = nameCell ? nameCell.text : '';
      if (!rowName || /^grand total$/i.test(rowName)) continue;
      checked++;
      if (nameKey(rowName) !== target) continue;
      const monthly = {};
      for (const c of row) {
        if (monthCols.includes(c.col) && c.text !== '') monthly[header[c.col]] = Number.isNaN(Number(c.text)) ? c.text : Number(c.text);
      }
      const total = totalCol ? row.find(c => c.col === totalCol) : null;
      matches.push({
        name: rowName,
        list_year: list.year,
        grand_total: total && total.text !== '' ? Number(total.text) : null,
        monthly,
        list_url: list.url,
      });
    }
    if (checked === 0) return { ok: false, reason: 'layout_changed', url: list.url, year: list.year, excerpt: 'no employer rows found' };
    return { ok: true, url: list.url, year: list.year, checked, matches };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      reason: timeout ? 'timeout' : 'other',
      url: list.url,
      year: list.year,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = nameKey(typeof keyword === 'string' ? keyword : '');
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: STATS_PAGE, excerpt: 'empty company name' };
    }
    const results = await Promise.all(LISTS.map(list => searchList(list, target)));
    const records = results.filter(r => r.ok).flatMap(r => r.matches);

    if (records.length > 0) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: first.list_url,
        excerpt: `Listed in the employment permit company list ${[...new Set(records.map(r => r.list_year))].join(', ')} as "${first.name}"`,
      };
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      const f = failed[0];
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: f.url,
        excerpt: failed.map(r => `${r.year} list: ${r.reason} (${r.excerpt})`).join('; ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: STATS_PAGE,
      excerpt: results.map(r => `${r.year} list: ${r.checked} employers checked, no match`).join('; '),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: STATS_PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
