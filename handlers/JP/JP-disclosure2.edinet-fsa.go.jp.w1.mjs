export const meta = {
  task: 'JP-disclosure2.edinet-fsa.go.jp',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_en', 'name_yomi', 'edinet_code', 'filer_type', 'listing_status', 'securities_code', 'corporate_number', 'address', 'industry'],
  canary: { found: 'トヨタ自動車株式会社', not_found: 'ゼノテスト株式会社' },
};

// EDINET code list (every filer EDINET knows about), published by the FSA as a zip of one Shift_JIS CSV.
const LIST_URL = 'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CACHE_MS = 6 * 60 * 60 * 1000;
let cache = null;

const nfkc = (s) => String(s ?? '').normalize('NFKC');

function couldnt(reason, excerpt) {
  const e = new Error(String(excerpt || ''));
  e.couldnt = true;
  e.reason = reason;
  return e;
}

function failure(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt || '').slice(0, 300) };
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/** Returns the bytes of the CSV inside the zip, inflated when the zip stores it deflated. */
async function readCsvFromZip(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 65535; i--) {
    if (u32(zip, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no zip end record');
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  for (let n = 0; n < count; n++) {
    if (u32(zip, p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = u16(zip, p + 10);
    const csize = u32(zip, p + 20);
    const nlen = u16(zip, p + 28);
    const xlen = u16(zip, p + 30);
    const clen = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = new TextDecoder('utf-8').decode(zip.subarray(p + 46, p + 46 + nlen));
    if (/\.csv$/i.test(name)) {
      if (u32(zip, local) !== 0x04034b50) throw new Error('bad zip local header');
      const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
      const data = zip.subarray(start, start + csize);
      if (method === 0) return data;
      if (method !== 8) throw new Error('unsupported zip method ' + method);
      if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream not available');
      const inflated = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(inflated).arrayBuffer());
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error('no csv inside zip');
}

/** RFC 4180-style CSV: quoted fields may hold commas, line breaks and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Legal-form words are dropped on both sides before comparing, so "(株)", "株式会社", "Co., Ltd." and "Corporation" do not decide a match.
const JA_LEGAL = /株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|\(株\)|\(有\)|\(同\)|\(合\)|\(資\)|\(名\)/g;
const EN_LEGAL = /\b(co|company|corporation|corp|incorporated|inc|limited|ltd|llc|plc|kk)\b/g;
function normName(s, english) {
  let t = nfkc(s).toLowerCase().replace(JA_LEGAL, ' ');
  if (english) t = t.replace(EN_LEGAL, ' ');
  return t.replace(/[^\p{L}\p{N}]/gu, '');
}

async function loadList() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;

  const res = await fetch(LIST_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'application/zip,application/octet-stream,*/*' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) throw couldnt('blocked', `HTTP ${res.status}`);
  if (!res.ok) throw couldnt('http_error', `HTTP ${res.status}`);

  const zip = new Uint8Array(await res.arrayBuffer());
  if (zip.length < 4 || u32(zip, 0) !== 0x04034b50) {
    throw couldnt('layout_changed', 'not a zip: ' + new TextDecoder().decode(zip.subarray(0, 120)));
  }

  let bytes;
  try {
    bytes = await readCsvFromZip(zip);
  } catch (e) {
    throw couldnt('layout_changed', 'zip: ' + e.message);
  }

  const grid = parseCsv(new TextDecoder('shift_jis').decode(bytes));
  const h = grid.findIndex((r) => r.some((c) => nfkc(c) === '提出者名'));
  if (h < 0) throw couldnt('layout_changed', 'no 提出者名 header in the code list');

  const head = grid[h].map((c) => nfkc(c));
  const col = (name) => head.indexOf(nfkc(name));
  const C = {
    code: col('EDINETコード'),
    type: col('提出者種別'),
    listing: col('上場区分'),
    name: col('提出者名'),
    nameEn: col('提出者名（英字）'),
    yomi: col('提出者名（ヨミ）'),
    industry: col('提出者業種'),
    sec: col('証券コード'),
    corp: col('提出者法人番号'),
    addr: col('所在地'),
  };
  if (C.code < 0 || C.name < 0) throw couldnt('layout_changed', 'EDINET code or name column missing');

  const rows = [];
  for (const r of grid.slice(h + 1)) {
    const g = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
    if (!g(C.code) || !g(C.name)) continue;
    rows.push({
      name: g(C.name),
      name_en: g(C.nameEn),
      name_yomi: g(C.yomi),
      edinet_code: g(C.code),
      filer_type: g(C.type),
      listing_status: g(C.listing),
      securities_code: g(C.sec),
      corporate_number: g(C.corp),
      address: g(C.addr),
      industry: g(C.industry),
      _ja: normName(g(C.name), false),
      _en: normName(g(C.nameEn), true),
    });
  }
  if (rows.length < 1000) throw couldnt('layout_changed', `only ${rows.length} rows in the code list`);

  cache = { at: Date.now(), rows, dateLabel: nfkc(grid[0]?.[1] || '') };
  return cache;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const typed = nfkc(keyword).trim();
    if (!typed) throw couldnt('other', 'empty company name');

    const list = await loadList();
    const kJa = normName(typed, false);
    const kEn = normName(typed, true);
    const hits = list.rows.filter((r) => (kJa && r._ja === kJa) || (kEn && r._en && r._en === kEn));

    if (hits.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No filer with this name in the EDINET code list (${list.dateLabel}, ${list.rows.length} filers)`,
      };
    }

    const records = hits.map((r) => ({
      name: r.name,
      name_en: r.name_en,
      name_yomi: r.name_yomi,
      edinet_code: r.edinet_code,
      filer_type: r.filer_type,
      listing_status: r.listing_status,
      securities_code: r.securities_code,
      corporate_number: r.corporate_number,
      address: r.address,
      industry: r.industry,
    }));
    const excerpt = records
      .slice(0, 3)
      .map((r) => `${r.name} | ${r.name_en} | ${r.edinet_code}`)
      .join(' ; ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `EDINET code list ${list.dateLabel}: ${excerpt}`.slice(0, 300),
    };
  } catch (err) {
    if (err && err.couldnt) return failure(err.reason, err.message);
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
