export const meta = {
  task: 'ID-infoalkes.kemkes.go.id',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'role', 'registration_no', 'product_name', 'product_category', 'product_description', 'device_group',
    'model', 'product_class', 'status', 'issued', 'expiry', 'registrant_address', 'manufacturer', 'manufacturer_country', 'kind'],
  canary: { found: 'PT. SENTRAL MEDIKA INDOPUTRA', not_found: 'PT Fiktif Tidak Terdaftar Kebohongan' },
};

const BASE = 'https://infoalkes.kemkes.go.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ROWS = 100;
// Indonesian and common foreign legal-form words: ignored when comparing names.
const LEGAL = new Set(['PT', 'PERSERO', 'PERUM', 'TBK', 'CV', 'UD', 'FA', 'SDN', 'BHD', 'LTD', 'LIMITED', 'PTE', 'LLC', 'INC', 'CORP', 'GMBH', 'PLC', 'LLP']);

const isLegal = (t) => LEGAL.has(t.replace(/[^\p{L}]/gu, '').toUpperCase());
/** Words sent to the site's search: the name without its legal form. */
const searchTerm = (s) => String(s || '').split(/[\s.,]+/).filter((t) => t && !isLegal(t)).join(' ');
/** Comparison key: letters and digits only, legal form removed, case ignored. */
const compareKey = (s) => String(s || '').split(/[\s.,]+/).filter((t) => t && !isLegal(t)).join('')
  .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

const decode = (s) => s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/&amp;/gi, '&');
const clean = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const bold = (html) => clean((String(html || '').match(/<b>([\s\S]*?)<\/b>/i) || [])[1]);
const divs = (html) => [...String(html || '').matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)].map((m) => clean(m[1])).filter(Boolean);
const badge = (html) => clean((String(html || '').match(/<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
const after = (list, label) => (list.find((x) => x.toLowerCase().startsWith(label)) || '').replace(/^[^:]*:\s*/, '');

function toRecord(d, role, name) {
  const mdivs = divs(d.MERK);
  return {
    name,
    role,
    registration_no: bold(d.NOMOR),
    product_name: bold(d.MERK),
    product_category: mdivs[0] || '',
    product_description: mdivs[1] || '',
    device_group: badge(d.MERK),
    model: bold(d.TIPE),
    product_class: after(divs(d.TIPE), 'kelas'),
    status: badge(d.STATUS_NIE),
    issued: after(divs(d.NOMOR), 'terbit'),
    expiry: after(divs(d.NOMOR), 'expired'),
    registrant_address: divs(d.PENDAFTAR)[0] || '',
    manufacturer: bold(d.PRODUSEN),
    manufacturer_country: divs(d.PRODUSEN)[0] || '',
    kind: badge(d.KETERANGAN),
  };
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  return list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

/** One search of the site's product table. Never throws. kat 3 = registrant (Pendaftar), kat 5 = manufacturer (Produsen). */
async function search(kat, term, page) {
  const source_url = `${BASE}/cari`;
  try {
    const body = new URLSearchParams({ kat_pencarian: String(kat), strCari: term, token: page.token, draw: '1', start: '0', length: String(ROWS) });
    const res = await fetch(`${BASE}/cari/getPencarian`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-TOKEN': page.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': source_url,
        'Origin': BASE,
        'Cookie': page.cookies,
      },
      body,
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    let json;
    try { json = JSON.parse(await res.text()); } catch { return { ok: false, reason: 'layout_changed', excerpt: 'search answer is not JSON' }; }
    if (!json || !Array.isArray(json.data) || typeof json.recordsFiltered !== 'number') {
      return { ok: false, reason: 'layout_changed', excerpt: 'search answer has no data list' };
    }
    return { ok: true, rows: json.data, total: json.recordsFiltered, kat };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const source_url = `${BASE}/cari`;
  try {
    const key = compareKey(keyword);
    const term = searchTerm(keyword);
    if (!key) return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'no usable name in the keyword' };

    // Step 1: the search page gives the CSRF token, the search token and the session cookie.
    const pageRes = await fetch(source_url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'id,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: `HTTP ${pageRes.status}` };
    }
    if (!pageRes.ok) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url, excerpt: `HTTP ${pageRes.status}` };
    const html = await pageRes.text();
    const csrf = (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    const token = (html.match(/searchToken = "([^"]+)"/) || [])[1];
    if (!csrf || !token) {
      const blocked = /Just a moment|cf-chl|captcha/i.test(html);
      return { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url,
        excerpt: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200) };
    }
    const page = { csrf, token, cookies: cookieHeader(pageRes) };

    // Step 2: search as registrant and as manufacturer, at the same time (the page is slow, so one after the other would not fit in 60 s).
    const [reg, man] = await Promise.all([search(3, term, page), search(5, term, page)]);

    const seen = new Set();
    const records = [];
    for (const r of [reg, man]) {
      if (!r.ok) continue;
      for (const d of r.rows) {
        const id = d.PRODUK_ID;
        if (seen.has(id)) continue;
        const registrant = bold(d.PENDAFTAR);
        const maker = bold(d.PRODUSEN);
        if (compareKey(registrant) === key) { seen.add(id); records.push(toRecord(d, 'registrant', registrant)); }
        else if (compareKey(maker) === key) { seen.add(id); records.push(toRecord(d, 'manufacturer', maker)); }
      }
    }

    const counts = `registrant search ${reg.ok ? reg.total : 'failed'} rows, manufacturer search ${man.ok ? man.total : 'failed'} rows`;
    if (records.length) {
      const partial = [reg, man].some((r) => r.ok && r.total > r.rows.length);
      return { status: 'found', reason: '', records, source_url,
        excerpt: `${records.length} product row(s) for this name; ${counts}${partial ? '; only the first ' + ROWS + ' rows of a search were read' : ''}` };
    }
    const failed = [reg, man].find((r) => !r.ok);
    if (failed) return { status: 'couldnt_check', reason: failed.reason, records: [], source_url, excerpt: `${failed.excerpt}; ${counts}` };
    const truncated = [reg, man].find((r) => r.total > r.rows.length);
    if (truncated) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url,
        excerpt: `${counts}; the name is not in the first ${ROWS} rows of a search that has ${truncated.total} rows` };
    }
    return { status: 'not_found', reason: '', records: [], source_url, excerpt: `0 matching rows; ${counts}` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url,
      excerpt: String(err?.message || err).slice(0, 200) };
  }
}
