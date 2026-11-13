export const meta = {
  task: 'ID-apjii.or.id', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'reg_no', 'brand', 'membership_type', 'licence_types', 'domain', 'address', 'kelurahan', 'kecamatan',
    'city', 'province', 'postal_code', 'phone', 'fax'],
  canary: { found: 'PT CYBERINDO ADITAMA', not_found: 'PT TIDAK TERDAFTAR SEJAHTERA' },
};

// APJII member directory (ISP operators). One GET with ?name= returns matching companies, each with a detail
// block (modal) in the same HTML. Pages come from &page=N.
const BASE = 'https://apjii.or.id/anggota/penyelengara';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const MAX_PAGES = 5;
const DEADLINE_MS = 50000;

// Legal forms are ignored when comparing names (PT, TBK, CV, ...).
const LEGAL = new Set(['PT', 'PERSERO', 'PERSEROAN', 'TBK', 'TERBATAS', 'CV', 'UD', 'PERUM', 'FIRMA', 'KOMANDITER',
  'LTD', 'LIMITED', 'PTE', 'SDN', 'BHD', 'LLC']);

const LABELS = {
  'no - reg': 'reg_no',
  'nama merk usaha': 'brand',
  'tipe keanggotaan': 'membership_type',
  'jenis perizinan': 'licence_types',
  'domain': 'domain',
  'alamat kantor': 'address',
  'kelurahan': 'kelurahan',
  'kecamatan': 'kecamatan',
  'kota': 'city',
  'propinsi': 'province',
  'kode pos': 'postal_code',
  'phone': 'phone',
  'fax': 'fax',
};

/** Upper-case words without punctuation and without legal form. Falls back to all words if nothing is left. */
function core(str) {
  const words = String(str || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const kept = words.filter((w) => !LEGAL.has(w));
  return (kept.length ? kept : words).join(' ');
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** One object per company: its name (modal header) and the labelled rows of its detail block. */
function parseCompanies(html) {
  const parts = html.split(/<div class="modal fade" id="detail-/i).slice(1);
  const out = [];
  for (const part of parts) {
    const nameMatch = part.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
    const name = nameMatch ? clean(nameMatch[1]) : '';
    if (!name) continue;
    const rec = { name };
    const liRe = /<li class="mb-2">\s*<span class="font-medium">([\s\S]*?)<\/span>\s*<span>([\s\S]*?)<\/span>\s*<\/li>/gi;
    for (const m of part.matchAll(liRe)) {
      const key = LABELS[clean(m[1]).toLowerCase()];
      if (key) rec[key] = clean(m[2]).replace(/^:\s*/, '');
    }
    out.push(rec);
  }
  return out;
}

function toRecord(c) {
  const rec = { name: c.name };
  for (const key of Object.values(LABELS)) rec[key] = c[key] || '';
  return rec;
}

/** Next page URL from the pagination links, if the page links to one. */
function nextPageUrl(html, page) {
  for (const m of html.matchAll(/href="([^"]*[?&]page=(\d+)[^"]*)"/gi)) {
    if (Number(m[2]) === page + 1) return new URL(m[1].replace(/&amp;/gi, '&'), BASE).href;
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Let the keep-alive socket settle before the runner exits: on Windows an immediate process.exit after fetch
  // aborts Node with a libuv assertion (exit 127) after the answer is printed.
  await new Promise((r) => setTimeout(r, 300));
  return answer;
}

async function search(keyword) {
  const started = Date.now();
  const search = core(keyword);
  const searchUrl = `${BASE}?name=${encodeURIComponent(search)}`;
  try {
    if (!search) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    const matches = [];
    let listed = 0;
    let url = searchUrl;
    let page = 1;

    for (;;) {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();

      const companies = parseCompanies(html);
      const emptyText = /tidak ditemukan/i.test(html);
      if (!companies.length && !emptyText) {
        const bot = /captcha|cf-chl|challenge-platform|just a moment/i.test(html);
        return {
          status: 'couldnt_check', reason: bot ? 'blocked' : 'layout_changed', records: [], source_url: url,
          excerpt: clean(html).slice(0, 300),
        };
      }

      listed += companies.length;
      for (const c of companies) {
        if (core(c.name) === search) matches.push(toRecord(c));
      }

      const next = nextPageUrl(html, page);
      if (!next) break;
      if (page >= MAX_PAGES) {
        if (matches.length) break;
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `more than ${MAX_PAGES} result pages, match not reached`,
        };
      }
      if (Date.now() - started > DEADLINE_MS) {
        if (matches.length) break;
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl, excerpt: 'page walk ran out of time' };
      }
      url = next;
      page += 1;
    }

    if (matches.length) {
      const first = matches[0];
      const excerpt = [first.name, first.reg_no && `Reg ${first.reg_no}`, first.brand && `Brand ${first.brand}`,
        first.membership_type, first.licence_types && `Licence ${first.licence_types}`, first.city]
        .filter(Boolean).join(' | ').slice(0, 500);
      return { status: 'found', reason: '', records: matches, source_url: searchUrl, excerpt };
    }

    return {
      status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: listed
        ? `Search "${search}" returned ${listed} listed operators, none with this name`
        : `Anggota penyelenggara tidak ditemukan (search "${search}")`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
