export const meta = { task: 'GB-barstandardsboard.org.uk', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'type_of_body', 'authorisation_valid_from', 'renewal_date', 'practising_address', 'reserved_activities'],
  canary: { found: 'Adelphi Law Ltd', not_found: 'Zorblax Unlisted Chambers Ltd' } };

// The BSB barristers register (search-the-register.html is a 404 now; the live register is
// /for-the-public/search-a-barristers-record/the-barristers-register.html) lists INDIVIDUALS only, so company
// names never match there. Companies (BSB-authorised bodies) are on the Entities Register, which the site
// publishes as one downloadable XLSX list. This handler reads that list.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': '*/*' };
const PAGE = 'https://www.barstandardsboard.org.uk/for-the-public/search-a-barristers-record/the-entities-register.html';
const LEGAL_FORM = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'inc', 'llc']);

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Lower case, punctuation removed, legal form words removed: "ADELPHI LAW LTD." -> "adelphi law". */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(/\s+/).filter((w) => w && !LEGAL_FORM.has(w)).join(' ');
}

/** Names one register row answers to: its main name, and any "(trading as X)" / "(trading name of X)" name. */
function candidates(cell) {
  const flat = clean(cell);
  const out = new Set();
  out.add(normalize(flat.replace(/\([^)]*\)/g, ' ')));
  for (const m of flat.matchAll(/\(([^)]*)\)/g)) {
    out.add(normalize(m[1].replace(/^\s*(trading\s+(as|name\s+of)|t\/a)\s+/i, '')));
  }
  out.delete('');
  return out;
}

function xmlDecode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** Download links on the page, nearest to the "DOWNLOAD THE LATEST REGISTER OF BSB ENTITIES" text first. */
function downloadCandidates(html) {
  const marks = [...html.matchAll(/LATEST REGISTER OF BSB ENTITIES/gi)].map((m) => m.index);
  if (!marks.length) return [];
  const links = [...html.matchAll(/href="(https:\/\/www\.barstandardsboard\.org\.uk\/asset\/[^"]+)"/gi)]
    .map((m) => ({ url: m[1], d: Math.min(...marks.map((p) => Math.abs(p - m.index))) }));
  links.sort((a, b) => a.d - b.d);
  return [...new Set(links.map((l) => l.url))];
}

/** Minimal zip reader (central directory + deflate-raw through the standard DecompressionStream). */
async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no zip directory');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    entries[new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen))] = { method, csize, loc };
    p += 46 + nlen + xlen + clen;
  }
  return async (name) => {
    const e = entries[name];
    if (!e) return null;
    const nlen = dv.getUint16(e.loc + 26, true);
    const xlen = dv.getUint16(e.loc + 28, true);
    const start = e.loc + 30 + nlen + xlen;
    const data = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error('unsupported zip method ' + e.method);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
}

async function readText(zip, name) {
  const b = await zip(name);
  return b ? new TextDecoder().decode(b) : null;
}

function parseSharedStrings(xml) {
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += t[1];
    out.push(xmlDecode(text));
  }
  return out;
}

/** Rows as { A: value, B: value, ... } keyed by column letter. */
function parseSheet(xml, sst) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*?(?<!\/)>([\s\S]*?)<\/row>/g)) {
    const vals = {};
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let val = '';
      if (t === 's') {
        const v = body.match(/<v>(\d+)<\/v>/);
        val = v ? (sst[Number(v[1])] ?? '') : '';
      } else if (t === 'inlineStr') {
        for (const x of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) val += x[1];
        val = xmlDecode(val);
      } else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        val = v ? xmlDecode(v[1]) : '';
      }
      vals[ref] = val;
    }
    rows.push(vals);
  }
  return rows;
}

/** Excel serial day number -> YYYY-MM-DD. */
function excelDate(v) {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n < 20000) return clean(v);
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalize(keyword);
    if (!key) return fail('other', PAGE, 'empty company name');

    const pageRes = await fetch(PAGE, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', PAGE, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return fail('http_error', PAGE, `HTTP ${pageRes.status}`);
    const html = await pageRes.text();
    if (/captcha|access denied|cf-chl/i.test(html)) return fail('blocked', PAGE, 'bot check page');
    if (!/Entities Register/i.test(html)) return fail('layout_changed', PAGE, html.slice(0, 200));

    let bytes = null;
    let fileUrl = '';
    for (const url of downloadCandidates(html)) {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      const cd = r.headers.get('content-disposition') || '';
      if (/spreadsheetml/i.test(ct) || /\.xlsx"?/i.test(cd)) {
        bytes = new Uint8Array(await r.arrayBuffer());
        fileUrl = url;
        break;
      }
    }
    if (!bytes) return fail('layout_changed', PAGE, 'no XLSX download link found on the Entities Register page');

    let rows;
    let header;
    try {
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('not a zip file');
      const zip = await readZip(bytes);
      const sheetXml = await readText(zip, 'xl/worksheets/sheet1.xml');
      if (!sheetXml) throw new Error('sheet1 missing');
      const sst = parseSharedStrings((await readText(zip, 'xl/sharedStrings.xml')) || '');
      rows = parseSheet(sheetXml, sst);
      const hdrIdx = rows.findIndex((r) => r.A === 'BSB Authorised Body');
      if (hdrIdx < 0 || !rows.slice(0, hdrIdx).some((r) => /Entities Register/i.test(r.A || ''))) {
        throw new Error('header row not found: ' + (rows[0]?.A || ''));
      }
      header = rows[hdrIdx];
      rows = rows.slice(hdrIdx + 1).filter((r) => clean(r.A));
    } catch (err) {
      return fail('layout_changed', fileUrl, 'could not read the register XLSX: ' + String(err?.message || err));
    }

    const hits = rows.filter((r) => candidates(r.A).has(key));
    if (!hits.length) {
      return { status: 'not_found', reason: '', records: [], source_url: fileUrl,
        excerpt: `0 matches among ${rows.length} entities on the BSB Entities Register` };
    }

    const records = hits.map((r) => {
      const reserved = {};
      for (const col of Object.keys(header)) {
        if (col.length === 1 && col >= 'K' && header[col] && clean(r[col])) reserved[clean(header[col])] = clean(r[col]);
      }
      return {
        name: clean(r.A),
        type_of_body: clean(r.B),
        authorisation_valid_from: excelDate(r.C),
        renewal_date: excelDate(r.D),
        practising_address: clean(r.E),
        reserved_activities: reserved,
      };
    });
    return { status: 'found', reason: '', records, source_url: fileUrl,
      excerpt: records.map((r) => `${r.name} (${r.type_of_body})`).join(' | ').slice(0, 300) };
  } catch (err) {
    const reason = /Timeout|Abort/i.test(String(err?.name)) ? 'timeout' : 'other';
    return fail(reason, PAGE, String(err?.message || err));
  }
}
