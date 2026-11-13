export const meta = {
  task: 'PH-peza.gov.ph',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list_file', 'row_values'],
  canary: { found: 'Saint Cabrini Medical Center, Inc.', not_found: 'Kumpanyang Hindi Nakalista, Inc.' },
};

// The site has no company search. Its homepage offers five static Excel lists ("Download File" links).
const HOME = 'https://www.peza.gov.ph/';
const LISTS = [1, 2, 3, 4, 5].map((n) => `https://www.peza.gov.ph/sites/default/files/${n}.xls`);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc']);

/** Comparable form of a company name: accents, case, punctuation and legal form removed. */
function normalize(str) {
  return String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter((w) => w && !LEGAL.has(w)).join('');
}

/** Reads BIFF8 strings across CONTINUE records (a string continued in the next record starts with a flags byte). */
class SegReader {
  constructor(segs) { this.segs = segs; this.si = 0; this.pos = 0; }
  u8() {
    while (this.si < this.segs.length && this.pos >= this.segs[this.si].length) { this.si++; this.pos = 0; }
    if (this.si >= this.segs.length) throw new Error('BIFF string data ends early');
    return this.segs[this.si][this.pos++];
  }
  u16() { const lo = this.u8(); return lo | (this.u8() << 8); }
  u32() { const lo = this.u16(); return lo + this.u16() * 65536; }
  skip(n) { for (let i = 0; i < n; i++) this.u8(); }
  chars(cch, high) {
    let out = '';
    let left = cch;
    while (left > 0) {
      const seg = this.segs[this.si];
      if (!seg) throw new Error('BIFF string data ends early');
      const avail = seg.length - this.pos;
      if (avail <= 0) { this.si++; this.pos = 0; high = this.u8() & 1; continue; }
      if (high) {
        if (avail < 2) { // one byte of a UTF-16 character is left in this record
          const lo = seg[this.pos++];
          this.si++; this.pos = 0;
          high = this.u8() & 1;
          const hi = this.u8();
          out += String.fromCharCode(lo | (hi << 8));
          left--;
          continue;
        }
        const n = Math.min(left, avail >> 1);
        for (let k = 0; k < n; k++) out += String.fromCharCode(seg.readUInt16LE(this.pos + 2 * k));
        this.pos += 2 * n;
        left -= n;
      } else {
        const n = Math.min(left, avail);
        out += seg.toString('latin1', this.pos, this.pos + n);
        this.pos += n;
        left -= n;
      }
    }
    return out;
  }
  xlString() {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 8 ? this.u16() : 0;
    const ext = flags & 4 ? this.u32() : 0;
    const text = this.chars(cch, flags & 1);
    this.skip(runs * 4 + ext);
    return text;
  }
}

/** Reads one stream out of an OLE2 (compound file) container. */
function cfbStream(buf, name) {
  const SS = 1 << buf.readUInt16LE(0x1e);
  const MSS = 1 << buf.readUInt16LE(0x20);
  const cutoff = buf.readUInt32LE(0x38);
  const numFat = buf.readUInt32LE(0x2c);
  const firstDir = buf.readUInt32LE(0x30);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  const firstDifat = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);
  const sec = (id) => {
    const off = (id + 1) * SS;
    if (off >= buf.length) throw new Error('sector beyond end of file');
    return buf.subarray(off, Math.min(off + SS, buf.length));
  };
  const fatIds = [];
  for (let i = 0; i < 109; i++) { const id = buf.readUInt32LE(0x4c + i * 4); if (id < 0xfffffffa) fatIds.push(id); }
  let d = firstDifat;
  for (let k = 0; k < numDifat && d < 0xfffffffa; k++) {
    const s = sec(d);
    for (let i = 0; i < SS / 4 - 1; i++) { const id = s.readUInt32LE(i * 4); if (id < 0xfffffffa) fatIds.push(id); }
    d = s.readUInt32LE(SS - 4);
  }
  const fat = [];
  for (const id of fatIds.slice(0, numFat)) {
    const s = sec(id);
    for (let i = 0; i < SS / 4; i++) fat.push(s.readUInt32LE(i * 4));
  }
  const chainOf = (table, start) => {
    const out = [];
    let s = start;
    while (s < 0xfffffffa) {
      if (out.length > 1e6 || table[s] === undefined) throw new Error('broken sector chain');
      out.push(s);
      s = table[s];
    }
    return out;
  };
  const readChain = (start) => Buffer.concat(chainOf(fat, start).map(sec));

  const dir = readChain(firstDir);
  let root = null;
  let target = null;
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nlen = dir.readUInt16LE(off + 64);
    const entry = {
      name: dir.toString('utf16le', off, off + Math.max(0, nlen - 2)),
      type: dir[off + 66],
      start: dir.readUInt32LE(off + 116),
      size: dir.readUInt32LE(off + 120),
    };
    if (entry.type === 5) root = entry;
    if (entry.type === 2 && entry.name === name) target = entry;
  }
  if (!target) throw new Error(`no ${name} stream`);
  if (target.size >= cutoff) return readChain(target.start).subarray(0, target.size);
  // small streams live in the mini stream
  const miniFat = [];
  const mf = readChain(firstMiniFat);
  for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readUInt32LE(i * 4));
  const mini = readChain(root.start);
  return Buffer.concat(chainOf(miniFat, target.start).map((s) => mini.subarray(s * MSS, (s + 1) * MSS))).subarray(0, target.size);
}

/** Returns every text cell of every sheet, plus rows grouped by sheet and row number. */
function parseWorkbook(buf) {
  if (buf.length < 512 || buf.readUInt32BE(0) !== 0xd0cf11e0) throw new Error('file is not an Excel (OLE2) workbook');
  const stream = cfbStream(buf, 'Workbook');
  const recs = [];
  for (let p = 0; p + 4 <= stream.length;) {
    const type = stream.readUInt16LE(p);
    const len = stream.readUInt16LE(p + 2);
    recs.push({ type, data: stream.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  if (!recs.length || recs[0].type !== 0x809 || recs[0].data.readUInt16LE(0) !== 0x600) throw new Error('not a BIFF8 workbook');

  const sstAt = recs.findIndex((r) => r.type === 0xfc);
  let sst = [];
  if (sstAt >= 0) {
    const segs = [recs[sstAt].data];
    for (let j = sstAt + 1; j < recs.length && recs[j].type === 0x3c; j++) segs.push(recs[j].data);
    const r = new SegReader(segs);
    r.u32();
    const count = r.u32();
    for (let i = 0; i < count; i++) sst.push(r.xlString());
  }

  const cells = [];
  let sheet = -1;
  for (const { type, data } of recs) {
    if (type === 0x809) {
      if (data.readUInt16LE(2) === 0x10) sheet++; // worksheet substream
    } else if (type === 0xfd) { // LABELSST: string from the shared string table
      const idx = data.readUInt32LE(6);
      if (idx >= sst.length) throw new Error('shared string index out of range');
      cells.push({ sheet, row: data.readUInt16LE(0), col: data.readUInt16LE(2), text: sst[idx] });
    } else if (type === 0x204) { // LABEL: inline string
      const text = new SegReader([data.subarray(6)]).xlString();
      cells.push({ sheet, row: data.readUInt16LE(0), col: data.readUInt16LE(2), text });
    }
  }
  const rows = new Map();
  for (const c of cells) {
    const key = `${c.sheet}:${c.row}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(c);
  }
  return { cells, rows };
}

async function loadList(url) {
  const fail = (reason, detail) => ({ url, reason, detail, parsed: null });
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/vnd.ms-excel,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let parsed;
    try {
      parsed = parseWorkbook(buf);
    } catch (e) {
      return fail('layout_changed', `${e.message} (${buf.length} bytes, starts ${buf.subarray(0, 8).toString('hex')})`);
    }
    if (parsed.cells.length === 0) return fail('layout_changed', 'no cells found in the list');
    return { url, reason: '', detail: '', parsed };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String((err && err.message) || err).slice(0, 200));
  }
}

function findInList(parsed, kwNorm, file) {
  const hits = [];
  const seen = new Set();
  for (const c of parsed.cells) {
    if (!c.text.trim() || normalize(c.text) !== kwNorm) continue;
    const rowValues = parsed.rows.get(`${c.sheet}:${c.row}`)
      .sort((a, b) => a.col - b.col)
      .map((x) => x.text.trim())
      .filter(Boolean);
    const key = `${file}|${c.text.trim()}|${rowValues.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ name: c.text.trim(), list_file: file, row_values: rowValues });
  }
  return hits;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kwNorm = normalize(keyword);
  if (!kwNorm) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: HOME, excerpt: 'the company name is empty after cleaning' };
  }
  try {
    const results = await Promise.all(LISTS.map(loadList));
    const records = [];
    let sourceUrl = '';
    for (const r of results) {
      if (!r.parsed) continue;
      const hits = findInList(r.parsed, kwNorm, r.url.split('/').pop());
      if (hits.length && !sourceUrl) sourceUrl = r.url;
      records.push(...hits);
    }
    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: `${records[0].name} listed in ${records[0].list_file}`.slice(0, 500),
      };
    }
    const failed = results.filter((r) => !r.parsed);
    if (failed.length) {
      return {
        status: 'couldnt_check',
        reason: failed[0].reason,
        records: [],
        source_url: failed[0].url,
        excerpt: failed.map((f) => `${f.url.split('/').pop()}: ${f.reason} ${f.detail}`).join('; ').slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: HOME,
      excerpt: `Checked ${results.length} PEZA lists (${results.map((r) => r.parsed.cells.length + ' cells').join(', ')}); no entry matches "${keyword}"`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: HOME,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
