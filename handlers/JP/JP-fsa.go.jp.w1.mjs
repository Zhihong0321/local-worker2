export const meta = {
  task: 'JP-fsa.go.jp', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'list', 'list_url', 'sheet', 'agency', 'registration_number', 'registration_date', 'corporate_number', 'address', 'phone', 'columns'],
  canary: { found: '株式会社ジャックス', not_found: '株式会社ダミーテスト存在しない' },
};

// The FSA publishes its registers as static XLSX files (linked from /menkyo/menkyo.html and from a few
// sub-index pages under /menkyo/). The handler reads every linked XLSX itself (zip + DecompressionStream, no imports)
// and matches the company name against the name columns. The FSA's bulk search (search.fsa.go.jp) is not used:
// it refuses requests from some countries (CloudFront 403).

const BASE = 'https://www.fsa.go.jp';
const INDEX_URL = `${BASE}/menkyo/menkyo.html`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEADLINE_MS = 50_000;
const CONCURRENCY = 8;

class Fail extends Error {
  constructor(reason, message, url) { super(message); this.reason = reason; this.url = url; }
}

async function get(url, bytes = false) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    throw new Fail(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'other', String(e?.message || e), url);
  }
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`, url);
  try {
    return bytes ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  } catch (e) {
    throw new Fail(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'other', 'body read failed: ' + String(e?.message || e), url);
  }
}

function toUrl(href) {
  try { return new URL(href, BASE); } catch { return null; }
}

function isRegisterXlsx(u) {
  return u && u.hostname === 'www.fsa.go.jp' && u.pathname.startsWith('/menkyo/') && /\.xlsx$/i.test(u.pathname);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** Index page -> list of XLSX URLs, one level down through the linked /menkyo/ sub-index pages. */
async function discover() {
  const index = await get(INDEX_URL);
  if (!index.includes('免許・許可・登録等を受けている事業者一覧')) {
    throw new Fail('layout_changed', 'register index page has no expected title', INDEX_URL);
  }
  const xlsx = new Set();
  const pages = new Set();
  for (const m of index.matchAll(/href="([^"]+)"/gi)) {
    const u = toUrl(m[1]);
    if (!u || u.hostname !== 'www.fsa.go.jp' || !u.pathname.startsWith('/menkyo/')) continue;
    if (/\.xlsx$/i.test(u.pathname)) xlsx.add(u.href);
    else if (/\.html?$/i.test(u.pathname) && u.pathname !== '/menkyo/menkyo.html') pages.add(u.href);
  }
  const failures = [];
  const subPages = await mapLimit([...pages], CONCURRENCY, async (p) => {
    try { return await get(p); } catch (e) { failures.push(e instanceof Fail ? e : new Fail('other', String(e), p)); return null; }
  });
  for (const html of subPages) {
    if (!html) continue;
    for (const m of html.matchAll(/href="([^"]+)"/gi)) {
      const u = toUrl(m[1]);
      if (isRegisterXlsx(u)) xlsx.add(u.href);
    }
  }
  return { lists: [...xlsx], failures };
}

// ---- minimal XLSX reader (zip central directory + DecompressionStream('deflate-raw')) ----

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const wanted = /^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/;
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!wanted.test(name)) continue;
    if (dv.getUint32(loff, true) !== 0x04034b50) throw new Error('bad zip entry');
    const start = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
    const data = buf.subarray(start, start + csize);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflateRaw(data));
    else throw new Error('unsupported zip method ' + method);
  }
  return files;
}

const unesc = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');
// Japanese phonetic guides (<rPh>) are dropped so they never end up in a name.
const runText = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
  .map((m) => unesc(m[1])).join('');
const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const cleanCell = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();

function parseShared(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let v;
      if (type === 's') v = shared[+(/<v>(\d+)<\/v>/.exec(body)?.[1] ?? -1)] ?? '';
      else if (type === 'inlineStr') v = runText(body);
      else v = unesc(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      row[colIndex(ref[1])] = v;
    }
    rows.push(Array.from(row, (x) => cleanCell(x)));
  }
  return rows;
}

// ---- matching ----

const JP_FORMS = [
  '株式会社', '有限会社', '合同会社', '合名会社', '合資会社', '相互会社', '保険相互会社',
  '一般社団法人', '一般財団法人', '社団法人', '財団法人', '特定非営利活動法人',
];
const EN_FORMS = ['kabushikikaisha', 'coltd', 'ltd', 'inc', 'corporation', 'corp', 'limited'];
const LEGAL_FORMS = [...JP_FORMS, ...EN_FORMS];

/**
 * Case, width, punctuation, spaces and legal form removed, so "(株)ジャックス", "ジャックス株式会社" and
 * "ジャックス" compare equal. Japanese forms are removed from either end; English forms only from the end.
 */
function normName(s) {
  let t = String(s ?? '').normalize('NFKC').replace(/\(株\)/g, '株式会社').toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of JP_FORMS) {
      if (t.length > f.length && t.startsWith(f)) { t = t.slice(f.length); changed = true; }
      if (t.length > f.length && t.endsWith(f)) { t = t.slice(0, -f.length); changed = true; }
    }
    for (const f of EN_FORMS) {
      if (t.length > f.length && t.endsWith(f)) { t = t.slice(0, -f.length); changed = true; }
    }
  }
  return t;
}

// Name columns: "業者名", "銀行名", "○○会社名", "届出者の商号、名称又は氏名", "名称" ...
// Not name columns: a person's name, the representative, the parent/affiliated company ("所属…名"), the prefecture.
const isNameHeader = (c) => c.length <= 40 && (/商号/.test(c)
  || (/(名|名称)$/.test(c) && !/代表|役員|担当|理事|氏名|都道府県|所在地|所属|代理店の/.test(c)));
// Headers are bilingual in some lists ("登録番号 Registration No."): keep the Japanese part.
const cleanHeader = (c) => c.replace(/\s+[A-Za-z][\x21-\x7e\s]*$/, '').trim();
// A header row has a company-name column and at least one other register column.
const isHeaderRow = (cells) => (cells.some(isNameHeader) && cells.some((c) => /番号|所管|管轄|所在地|法人|年月日|電話/.test(c)))
  // foreign audit firms list: its name column has no header text (see nameColumns)
  || (cells.some((c) => /整理\s*番号/.test(c)) && cells.some((c) => /届出年月日/.test(c)));

/** Name column indexes of a header row. A bare "名称" is used only when the row has no more specific name column. */
function nameColumns(header) {
  const named = header.map((c, i) => (isNameHeader(c) ? i : -1)).filter((i) => i >= 0);
  const specific = named.filter((i) => header[i] !== '名称');
  if (specific.length) return specific;
  if (named.length) return named;
  // foreign audit firms list (fafia.xlsx): the blank header column right after 届出年月日 holds the firm name
  return header.map((c, i) => (c === '' && i > 0 && /届出年月日/.test(header[i - 1]) ? i : -1)).filter((i) => i >= 0);
}

function fieldFor(h) {
  if (/法人番号/.test(h)) return 'corporate_number';
  if (/郵便/.test(h)) return null;
  if (/電話/.test(h)) return 'phone';
  if (/所在地|住所/.test(h)) return 'address';
  if (/所管/.test(h)) return 'agency';
  if (/番号$/.test(h)) return 'registration_number';
  if (/^(登録|免許|許可|届出|認可)年月日$/.test(h)) return 'registration_date';
  return null;
}

function excelDate(v) {
  const n = Number(v);
  if (!/^\d{5}$/.test(String(v).trim()) || n < 20000 || n > 80000) return v;
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}

function scanRows(rows, key) {
  const matches = [];
  let header = null;
  let nameCols = [];
  let headerCount = 0;
  for (const cells of rows) {
    if (isHeaderRow(cells.map(cleanHeader))) {
      header = cells.map(cleanHeader);
      nameCols = nameColumns(header);
      headerCount++;
      continue;
    }
    if (!header) continue;
    for (const ci of nameCols) {
      if (cells[ci] && normName(cells[ci]) === key) matches.push({ ci, cells, header });
    }
  }
  return { headerCount, matches };
}

function toRecord(list, sheet, m) {
  const rec = { list: list.name, list_url: list.url, sheet, name: m.cells[m.ci], columns: {} };
  m.header.forEach((h, i) => {
    if (!h || i === m.ci || m.cells[i] === undefined) return;
    const value = h.includes('年月日') ? excelDate(m.cells[i]) : m.cells[i];
    rec.columns[h] = value;
    const f = fieldFor(h);
    if (f && !(f in rec)) rec[f] = value;
  });
  return rec;
}

async function scanList(url, key) {
  const files = await readZip(await get(url, true));
  if (!files.get('xl/workbook.xml')) throw new Error('workbook.xml missing');
  const dec = new TextDecoder();
  const shared = files.get('xl/sharedStrings.xml') ? parseShared(dec.decode(files.get('xl/sharedStrings.xml'))) : [];
  const sheetFiles = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const name = decodeURIComponent(url.split('/').pop());
  const records = [];
  let headers = 0;
  for (const sf of sheetFiles) {
    const rows = parseSheet(dec.decode(files.get(sf)), shared);
    const r = scanRows(rows, key);
    headers += r.headerCount;
    for (const m of r.matches) records.push(toRecord({ name, url }, sf.split('/').pop(), m));
  }
  if (headers === 0) throw new Error('no header row with a company-name column in any sheet');
  return records;
}

async function runLookup(keyword, key) {
  let discovered;
  try {
    discovered = await discover();
  } catch (e) {
    if (e instanceof Fail) return { status: 'couldnt_check', reason: e.reason, records: [], source_url: e.url || INDEX_URL, excerpt: e.message };
    throw e;
  }
  const { lists, failures } = discovered;
  const fails = [...failures];
  if (lists.length === 0) fails.push(new Fail('layout_changed', 'no XLSX register lists linked from the register pages', INDEX_URL));

  const per = await mapLimit(lists, CONCURRENCY, async (url) => {
    try {
      return { url, records: await scanList(url, key) };
    } catch (e) {
      return { url, fail: e instanceof Fail ? e : new Fail('layout_changed', String(e?.message || e), url) };
    }
  });

  const records = [];
  for (const r of per) {
    if (r.fail) fails.push(r.fail);
    else records.push(...r.records);
  }

  if (records.length) {
    const first = Object.entries(records[0].columns).map(([k, v]) => `${k}: ${v}`).join(' | ');
    return {
      status: 'found', reason: '', records, source_url: records[0].list_url,
      excerpt: `${records.length} register entr${records.length === 1 ? 'y' : 'ies'} for "${keyword}". ${first}`.slice(0, 500),
    };
  }
  if (fails.length) {
    const f = fails.find((x) => x.reason === 'blocked') || fails[0];
    return {
      status: 'couldnt_check', reason: f.reason, records: [], source_url: f.url || INDEX_URL,
      excerpt: `${fails.length} of ${lists.length} register files could not be read; first: ${f.message}`.slice(0, 500),
    };
  }
  return {
    status: 'not_found', reason: '', records: [], source_url: INDEX_URL,
    excerpt: `checked ${lists.length} register XLSX files; no company with this normalised name`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let timer;
  try {
    const key = normName(keyword);
    if (!key || LEGAL_FORMS.includes(key)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX_URL,
        excerpt: 'the name has nothing left to match after removing punctuation and legal form' };
    }
    const work = runLookup(keyword, key);
    work.catch(() => {});
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), DEADLINE_MS); });
    const answer = await Promise.race([work, deadline]);
    if (answer === null) {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: INDEX_URL,
        excerpt: `the register files were not all read within ${DEADLINE_MS / 1000} s` };
    }
    return answer;
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX_URL,
      excerpt: String(e?.message || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
