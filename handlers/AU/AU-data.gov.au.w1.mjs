export const meta = {
  task: 'AU-data.gov.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'abn', 'total_income', 'taxable_income', 'tax_payable', 'income_year', 'source_sheet', 'source_file'],
  canary: { found: '1ST ENERGY PTY LTD', not_found: 'ZORBLEFLAX QUORN PTY LTD' },
};

const DATASET_PAGE = 'https://data.gov.au/data/dataset/corporate-transparency';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://data.gov.au/data/dataset/c2524c87-cea4-4636-acac-599a82048a26/resource/';

// The 12 yearly workbooks listed on the dataset page (income years 2013-14 to 2024-25).
const FILES = [
  BASE + '15bf4eaa-7a14-48e9-8a3f-092df32a644e/download/2024-25-corporate-report-of-entity-tax-information.xlsx',
  BASE + '491b366b-aa6f-4b1c-b39d-cebaeeb6f874/download/2023-24-corporate-report-of-entity-tax-information.xlsx',
  BASE + '3281f733-6f53-431b-84f5-d824c6bd9e60/download/2022-23-corporate-report-of-entity-tax-information.xlsx',
  BASE + '6eaf8203-a79b-43f0-9671-feeb1a44cbff/download/2021-22-corporate-report-of-entity-tax-information.xlsx',
  BASE + '80a01133-4281-43ce-b5ef-5535d61e1c1f/download/2020-21-corporate-report-of-entity-tax-information.xlsx',
  BASE + 'db83e667-819f-41f3-a8b7-fcb13366105b/download/2019-20-corporate-report-of-entity-tax-information.xlsx',
  BASE + '827f68ea-83c0-440e-bb6d-4118644b7efd/download/2018-19-corporate-report-of-entity-tax-information.xlsx',
  BASE + '69b1061c-3769-48bd-b5a1-05e725543f6c/download/2017-18-corporate-report-of-entity-tax-information.xlsx',
  BASE + '5eb443b4-d0bb-4a88-a189-4523dbcd7f15/download/2016-17-corporate-report-of-entity-tax-information.xlsx',
  BASE + 'b84c2b8d-c595-4219-987d-fc1add7f00f0/download/2015-16-corporate-report-of-entity-tax-information.xlsx',
  BASE + '1e8c8ae0-81d1-4780-a669-9e4a2a6ba1a4/download/2014-15-corporate-report-of-entity-tax-information.xlsx',
  BASE + '237d7ede-3a63-4b9b-9434-2f79b9d70ce8/download/2013-14corporate-report-of-entity-tax-information.xlsx',
];

const LEGAL_WORDS = new Set(['pty', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'plc', 'sdn', 'bhd']);
const REASON_ORDER = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

/** Comparison key for a company name: lower case, no punctuation, no legal form. */
function core(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join('');
}

function xmlDecode(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return m ? xmlDecode(m[1]) : null;
}

/** Read the zip central directory of an .xlsx (a zip file). */
function zipIndex(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no zip end record');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, size, loc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { u8, dv, entries };
}

async function inflateRaw(data) {
  const input = new ReadableStream({ start(c) { c.enqueue(data); c.close(); } });
  const out = input.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function zipText(z, name) {
  const e = z.entries.get(name);
  if (!e) return null;
  const { u8, dv } = z;
  if (dv.getUint32(e.loc, true) !== 0x04034b50) throw new Error('bad zip entry ' + name);
  const start = e.loc + 30 + dv.getUint16(e.loc + 26, true) + dv.getUint16(e.loc + 28, true);
  const data = u8.subarray(start, start + e.size);
  let bytes = data;
  if (e.method === 8) bytes = await inflateRaw(data);
  else if (e.method !== 0) throw new Error('unsupported zip method ' + e.method);
  return new TextDecoder().decode(bytes);
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*?(?<!\/)>([\s\S]*?)<\/si>/g)].map((m) => {
    const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    return xmlDecode([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
  });
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Sheet XML -> array of rows, each row an array of cell texts (by column). */
function sheetRows(xml, strs) {
  const data = xml.match(/<sheetData\b[^>]*?(?<!\/)>([\s\S]*?)<\/sheetData>/);
  if (!data) return [];
  return [...data[1].matchAll(/<row\b[^>]*?(?<!\/)>([\s\S]*?)<\/row>/g)].map((rm) => {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r');
      const type = attr(cm[1], 't');
      const body = cm[2] || '';
      let val = '';
      if (type === 'inlineStr') {
        val = xmlDecode([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      } else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        if (v) val = type === 's' ? (strs[Number(v[1])] ?? '') : xmlDecode(v[1]);
      }
      row[ref ? colIndex(ref) : row.length] = String(val).trim();
    }
    return row;
  });
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : String(v);
}

function yearOf(s) {
  const m = String(s || '').match(/\d{4}-\d{2}/);
  return m ? m[0] : null;
}

/** One data sheet -> records. Columns are found by header text, so the 2013-2016 layouts work too. */
function parseSheet(rows, sheetName, fileUrl) {
  if (/prrt/i.test(sheetName)) return null;
  let hdr = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const h = Array.from(rows[i], (x) => String(x || '').toLowerCase().trim());
    const at = (re) => h.findIndex((x) => re.test(x));
    const name = at(/^name\b/);
    const abn = at(/^abn\b/);
    if (name >= 0 && abn >= 0) {
      cols = { name, abn, total: at(/total income/), taxable: at(/taxable income/), tax: at(/tax payable/), year: at(/income year/) };
      hdr = i;
      break;
    }
  }
  if (!cols || (cols.total < 0 && cols.tax < 0)) return null;
  const titleYear = yearOf(rows.slice(0, hdr).map((r) => Array.from(r).join(' ')).join(' '));
  const recs = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = String(r[cols.name] ?? '').trim();
    if (!name) continue;
    recs.push({
      name,
      abn: String(r[cols.abn] ?? '').replace(/\s+/g, ''),
      total_income: cols.total >= 0 ? num(r[cols.total]) : null,
      taxable_income: cols.taxable >= 0 ? num(r[cols.taxable]) : null,
      tax_payable: cols.tax >= 0 ? num(r[cols.tax]) : null,
      income_year: (cols.year >= 0 && String(r[cols.year] ?? '').trim()) || yearOf(sheetName) || titleYear,
      source_sheet: sheetName,
      source_file: fileUrl,
    });
  }
  return recs;
}

async function readWorkbook(u8, fileUrl) {
  const z = zipIndex(u8);
  const wb = await zipText(z, 'xl/workbook.xml');
  const rels = await zipText(z, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('no workbook.xml');
  const strs = sharedStrings(await zipText(z, 'xl/sharedStrings.xml'));
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) target[attr(m[0], 'Id')] = attr(m[0], 'Target');
  const out = [];
  let dataSheets = 0;
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const sheetName = attr(m[0], 'name') || '';
    let path = target[attr(m[0], 'r:id')];
    if (!path) continue;
    path = path.startsWith('/') ? path.slice(1) : 'xl/' + path;
    const xml = await zipText(z, path);
    if (!xml) continue;
    const recs = parseSheet(sheetRows(xml, strs), sheetName, fileUrl);
    if (recs) { dataSheets++; out.push(...recs); }
  }
  if (!dataSheets) throw new Error('no sheet with Name, ABN and income columns');
  return out;
}

async function getFile(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { url, reason: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { url, reason: 'http_error', detail: `HTTP ${res.status}` };
    const u8 = new Uint8Array(await res.arrayBuffer());
    if (u8[0] !== 0x50 || u8[1] !== 0x4b) return { url, reason: 'layout_changed', detail: 'not an xlsx (zip) file' };
    return { url, u8 };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { url, reason: timeout ? 'timeout' : 'other', detail: String((e && e.message) || e).slice(0, 120) };
  }
}

/** Look one company up in all yearly workbooks. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = core(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DATASET_PAGE,
        excerpt: 'no company name left after removing punctuation and legal form' };
    }

    const fetched = await Promise.all(FILES.map(getFile));
    const problems = [];
    const all = [];
    for (const f of fetched) {
      if (f.reason) { problems.push(f); continue; }
      try {
        all.push(...(await readWorkbook(f.u8, f.url)));
      } catch (e) {
        problems.push({ url: f.url, reason: 'layout_changed', detail: String((e && e.message) || e).slice(0, 120) });
      }
    }

    const seen = new Set();
    const matches = [];
    for (const r of all) {
      const k = [r.abn, r.income_year, r.total_income, r.taxable_income, r.tax_payable, r.name].join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      if (core(r.name) === key) matches.push(r);
    }

    const years = [...new Set(all.map((r) => r.income_year).filter(Boolean))].sort();
    const yearText = years.length ? `${years[0]} to ${years[years.length - 1]}` : 'no income years';
    const failNote = problems.length
      ? `${problems.length} of ${FILES.length} workbooks could not be read: ${problems.map((p) => `${p.reason} (${p.detail})`).join('; ')}.`
      : '';

    if (matches.length) {
      const names = [...new Set(matches.map((m) => m.name))].join('; ');
      return {
        status: 'found', reason: '', records: matches, source_url: DATASET_PAGE,
        excerpt: `${matches.length} matching row(s) for ${names}; income years ${yearText}. ${failNote}`.trim().slice(0, 500),
      };
    }
    if (problems.length) {
      const worst = REASON_ORDER.find((r) => problems.some((p) => p.reason === r)) || 'other';
      return { status: 'couldnt_check', reason: worst, records: [], source_url: DATASET_PAGE,
        excerpt: `No match found, but ${failNote}`.slice(0, 500) };
    }
    return { status: 'not_found', reason: '', records: [], source_url: DATASET_PAGE,
      excerpt: `No row with this name in ${FILES.length} of ${FILES.length} workbooks (income years ${yearText}).` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: DATASET_PAGE,
      excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
