export const meta = {
  task: 'MY-water.sabah.gov.my',
  want: 'w1',
  tier: 1,
  method: 'get',
  input: 'company name',
  fields: ['name', 'reg_no', 'category', 'district', 'address', 'phone'],
  canary: { found: 'A SAMBAS BIN MOKSIN', not_found: 'O2O Digital' },
};

const BASE = 'https://water.sabah.gov.my/licensed-plumber';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FORM_MARK = 'views-exposed-form-licensed-plumber-page-1';
const TABLE_HEAD = 'Name and Telephone Number';
const EMPTY_MARK = 'view-empty';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unent(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function text(html) {
  return unent(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function field(td, name) {
  const m = new RegExp('headers="' + name + '"[^>]*>([\\s\\S]*?)<\\/td>').exec(td);
  return m ? text(m[1]) : '';
}

function parseRows(html) {
  const out = [];
  const body = html.indexOf('<tbody>');
  const end = html.indexOf('</tbody>', body < 0 ? 0 : body);
  const seg = body >= 0 && end > body ? html.slice(body, end) : '';
  if (!seg) return out;
  const rows = seg.split(/<tr[ >]/).slice(1);
  for (const r of rows) {
    if (!/views-field-nothing/.test(r)) continue;
    const nameM = /<h2>([\s\S]*?)<\/h2>/.exec(r);
    if (!nameM) continue;
    const name = text(nameM[1]);
    const cell = /headers="view-nothing-table-column"[^>]*>([\s\S]*?)<\/td>/.exec(r);
    const inner = cell ? cell[1] : r;
    const ps = [...inner.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])).filter(Boolean);
    const regM = /No\.\s*Daftar\s*:\s*([^<]+)/i.exec(inner);
    const phoneM = /plumber-phone[\s\S]*?<span>([\s\S]*?)<\/span>/.exec(inner);
    // first <p> that is not the registration line is the address
    const addr = ps.filter((p) => !/^No\.\s*Daftar/i.test(p)).join(', ');
    out.push({
      name,
      reg_no: regM ? text(regM[1]) : '',
      category: field(r, 'view-field-plumber-category-table-column'),
      district: field(r, 'view-field-district-table-column'),
      address: addr,
      phone: phoneM ? text(phoneM[1]) : '',
    });
  }
  return out;
}

function hasNext(html) {
  return /title="Go to next page"/.test(html) || /rel="next"/.test(html);
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  const body = await res.text();
  return { status: res.status, body };
}

/** Look one company up. Must never throw. */
export default async function lookup(keyword) {
  const q = String(keyword == null ? '' : keyword).trim();
  if (!q) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty keyword' };
  }
  const url0 = BASE + '?title=' + encodeURIComponent(q);
  let first;
  try {
    first = await get(url0);
  } catch (e) {
    const reason = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'http_error';
    return { status: 'couldnt_check', reason, records: [], source_url: url0, excerpt: String(e && e.message || e).slice(0, 300) };
  }
  if (first.status === 403 || first.status === 429) {
    return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url0, excerpt: 'HTTP ' + first.status };
  }
  if (first.status !== 200) {
    return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url0, excerpt: 'HTTP ' + first.status };
  }
  const html = first.body;
  if (!html.includes(FORM_MARK)) {
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url0, excerpt: text(html).slice(0, 300) };
  }
  const tableOk = html.includes(TABLE_HEAD) && html.includes('views-view-table');
  const emptyOk = html.includes(EMPTY_MARK) && /No licensed plumber at the moment/i.test(html);
  if (!tableOk && !emptyOk) {
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url0, excerpt: text(html).slice(0, 300) };
  }

  let records = parseRows(html);
  // The exposed "Name" filter is a contains match; a broad keyword can span pages.
  let page = 0;
  let last = html;
  while (hasNext(last) && page < 4) {
    page += 1;
    await sleep(1100);
    let next;
    try {
      next = await get(url0 + '&page=' + page);
    } catch {
      break;
    }
    if (next.status !== 200) break;
    last = next.body;
    const more = parseRows(last);
    if (!more.length) break;
    records = records.concat(more);
  }

  // de-duplicate on name + reg_no
  const seen = new Set();
  records = records.filter((r) => {
    const k = (r.name + '|' + r.reg_no).toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!records.length) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url0,
      excerpt: 'No licensed plumber at the moment. (JANS licensee register, search "' + q + '")',
    };
  }

  const r0 = records[0];
  const excerpt = [r0.name, r0.reg_no && 'No. Daftar : ' + r0.reg_no, r0.category, r0.district, r0.address, r0.phone]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);
  return { status: 'found', reason: '', records, source_url: url0, excerpt };
}
