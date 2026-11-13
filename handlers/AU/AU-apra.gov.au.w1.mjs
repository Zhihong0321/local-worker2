export const meta = { task: 'AU-apra.gov.au', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'register', 'status', 'detail'],
  canary: { found: 'AMP Bank Ltd', not_found: 'Zorblax Quantum Holdings Pty Ltd' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://www.apra.gov.au/registers';

// Plain HTML lists on the APRA registers site (entity names in tables).
const HTML_LISTS = [
  { register: 'ADI (bank)', url: `${BASE}/list-registered-authorised-deposit-taking-institutions` },
  { register: 'General insurer', url: `${BASE}/list-registered-general-insurers` },
  { register: 'Life insurer or friendly society', url: `${BASE}/list-registered-life-insurers-and-friendly-societies` },
  { register: 'Private health insurer', url: `${BASE}/list-registered-private-health-insurers` },
];
// Superannuation: the page links to an XLSX download with the RSE funds and RSE licensees.
const SUPER_URL = `${BASE}/list-superannuation-institutions`;

const LEGAL_TAIL = new Set(['pty', 'ltd', 'limited', 'proprietary', 'co', 'company', 'inc', 'incorporated', 'corp',
  'corporation', 'llc', 'plc', 'nv', 'ag', 'gmbh']);
const NAME_HEADERS = /^(fund name|trustee name|rse licensee name|rse name|organisation name|licensee name|entity name|registered name)$/i;
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\ufeff\u00ad]/g;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = ENT[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}
function clean(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

// Normalised key for comparing names: case, punctuation, accents, leading "The", trailing legal form.
function nameKey(s) {
  let t = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(INVISIBLE, '').toLowerCase();
  t = t.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const tokens = t ? t.split(' ') : [];
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  while (tokens.length > 1 && LEGAL_TAIL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}
// Site names may carry a "(previously ...)" or "(trading as ...)" note: compare the part before it.
function siteKey(name) {
  return nameKey(String(name).split('(')[0]);
}

function rowCells(rowHtml) {
  const out = [];
  const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(rowHtml))) out.push({ inner: m[2], text: clean(m[2]) });
  return out;
}

// Entity name is the text before the document/download block that some cells carry.
function cellName(inner) {
  return clean(inner.split(/<div[\s>]/i)[0]).replace(/\*+$/, '').trim();
}

function extractEntries(html, list) {
  const entries = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(rowCells).filter((r) => r.length > 0);
    if (rows.length === 0) continue;
    // Key/value layout (private health insurers): one table per insurer.
    const phi = rows.find((r) => r.length >= 2 && r[0].text.toLowerCase() === 'registered name');
    if (phi) {
      const value = (label) => {
        const r = rows.find((x) => x.length >= 2 && x[0].text.toLowerCase() === label);
        return r ? r[1].text : '';
      };
      entries.push({ name: phi[1].text, register: list.register, status: value('membership type') || 'listed',
        detail: value('address'), url: list.url });
      continue;
    }
    // Name list: first row is the header; its second column says what the date means.
    const head = rows[0].map((c) => c.text).join(' | ').toLowerCase();
    let status = 'listed';
    if (head.includes('run-off')) status = 'run-off';
    else if (head.includes('revocation')) status = 'revoked';
    else if (head.includes('deregistration')) status = 'deregistered';
    for (const cells of rows.slice(1)) {
      const name = cellName(cells[0].inner);
      if (!name || /^(entity name|insurer|revoked insurers|deregistered insurers|registered name)$/i.test(name)) continue;
      const caption = cells[0].inner.match(/&quot;caption&quot;:&quot;([^&]+)&quot;/);
      const detail = cells[1] ? cells[1].text : (caption ? decode(caption[1]) : '');
      entries.push({ name, register: list.register, status, detail, url: list.url });
    }
  }
  return entries;
}

async function get(url, binary) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { err: timeout ? 'timeout' : 'other', excerpt: `${url}: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (res.status === 403 || res.status === 429) return { err: 'blocked', excerpt: `${url}: HTTP ${res.status}` };
  if (!res.ok) return { err: 'http_error', excerpt: `${url}: HTTP ${res.status}` };
  try {
    return { body: binary ? new Uint8Array(await res.arrayBuffer()) : await res.text() };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { err: timeout ? 'timeout' : 'other', excerpt: `${url}: ${String(e?.message || e).slice(0, 200)}` };
  }
}

async function checkHtmlList(list) {
  const got = await get(list.url, false);
  if (got.err) return { ok: false, reason: got.err, url: list.url, excerpt: got.excerpt };
  const entries = extractEntries(got.body, list);
  if (entries.length === 0) {
    if (/captcha|cf-chl|access denied|verify you are human/i.test(got.body)) {
      return { ok: false, reason: 'blocked', url: list.url, excerpt: 'bot or captcha page' };
    }
    return { ok: false, reason: 'layout_changed', url: list.url, excerpt: clean(got.body).slice(0, 200) };
  }
  return { ok: true, url: list.url, entries };
}

// ---- superannuation XLSX (zip with XML parts) ----
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no zip directory');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) {
      const lnlen = dv.getUint16(lho + 26, true);
      const lxlen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnlen + lxlen;
      const data = bytes.subarray(start, start + csize);
      const raw = method === 8 ? await inflateRaw(data) : data;
      out[name] = dec.decode(raw);
    }
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decode(x[1])).join('').replace(INVISIBLE, '').trim());
}

function parseSheet(xml, sst) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[2] || '';
      const body = c[3] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      if (type === 's') cells[c[1]] = v ? (sst[Number(v[1])] ?? '') : '';
      else if (type === 'inlineStr') cells[c[1]] = clean(body);
      else cells[c[1]] = v ? decode(v[1]).trim() : '';
    }
    rows.push(cells);
  }
  return rows;
}

function parseWorkbook(files) {
  const sst = files['xl/sharedStrings.xml'] ? parseSharedStrings(files['xl/sharedStrings.xml']) : [];
  const entries = [];
  const sheets = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
  for (const sheet of sheets) {
    const rows = parseSheet(files[sheet], sst);
    const idx = rows.findIndex((r) => Object.values(r).some((v) => NAME_HEADERS.test(v.trim())));
    if (idx < 0) continue;
    const header = rows[idx];
    const nameCol = Object.keys(header).find((c) => NAME_HEADERS.test(header[c].trim()));
    const register = /trustee|licensee/i.test(header[nameCol]) ? 'RSE licensee (superannuation)' : 'RSE fund (superannuation)';
    const cols = Object.keys(header).filter((c) => c !== nameCol && header[c]);
    for (const r of rows.slice(idx + 1)) {
      const name = (r[nameCol] || '').trim();
      if (!name) continue;
      const detail = cols.map((c) => `${header[c]}: ${r[c] || ''}`).join('; ');
      entries.push({ name, register, status: 'listed', detail, url: '' });
    }
  }
  return entries;
}

async function checkSuper() {
  const page = await get(SUPER_URL, false);
  if (page.err) return { ok: false, reason: page.err, url: SUPER_URL, excerpt: page.excerpt };
  const hrefs = [...page.body.matchAll(/href="([^"]+?\.xlsx[^"]*)"/gi)].map((m) => new URL(decode(m[1]), SUPER_URL).href);
  const xlsxUrl = hrefs.find((h) => /rse/i.test(h)) || hrefs[0];
  if (!xlsxUrl) return { ok: false, reason: 'layout_changed', url: SUPER_URL, excerpt: 'no XLSX link on the page' };
  const file = await get(xlsxUrl, true);
  if (file.err) return { ok: false, reason: file.err, url: xlsxUrl, excerpt: file.excerpt };
  let entries;
  try {
    entries = parseWorkbook(await readZip(file.body));
  } catch (e) {
    return { ok: false, reason: 'layout_changed', url: xlsxUrl, excerpt: String(e?.message || e).slice(0, 200) };
  }
  if (entries.length === 0) return { ok: false, reason: 'layout_changed', url: xlsxUrl, excerpt: 'no name rows in the XLSX' };
  for (const e of entries) e.url = xlsxUrl;
  return { ok: true, url: xlsxUrl, entries };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const userKey = nameKey(String(keyword ?? ''));
    if (!userKey) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name given' };

    const checks = await Promise.all([...HTML_LISTS.map((l) => checkHtmlList(l)), checkSuper()]);

    const seen = new Map();
    for (const c of checks) {
      if (!c.ok) continue;
      for (const e of c.entries) {
        if (siteKey(e.name) !== userKey) continue;
        const k = `${e.name}|${e.register}|${e.status}|${e.detail}`;
        if (!seen.has(k)) seen.set(k, { name: e.name, register: e.register, status: e.status, detail: e.detail, source_url: e.url });
      }
    }
    const records = [...seen.values()];
    if (records.length > 0) {
      return {
        status: 'found', reason: '', records, source_url: records[0].source_url,
        excerpt: `APRA register: ${records.map((r) => `${r.name} (${r.register}, ${r.status})`).join('; ')}`.slice(0, 500),
      };
    }

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      const worst = failed.map((f) => f.reason).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
      return {
        status: 'couldnt_check', reason: worst, records: [], source_url: failed[0].url,
        excerpt: failed.map((f) => `${f.url}: ${f.reason} ${f.excerpt || ''}`).join(' | ').slice(0, 500),
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: BASE,
      excerpt: `Checked ${HTML_LISTS.length + 1} APRA register lists (banks, general insurers, life insurers, private health insurers, superannuation XLSX); no name matches.`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
