export const meta = {
  task: 'VN-careerviet.vn',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'emp_id', 'address', 'company_size', 'business_type', 'website', 'tax_code', 'profile_url', 'profile_status'],
  canary: { found: 'CÔNG TY TNHH JOB HOUSE', not_found: 'Công ty TNHH Khoai Lang Vàng Không Tồn Tại' },
};

// CareerViet's own employer search (the JSON API behind careerviet.vn/cong-ty). No login, no token.
const API = 'https://internal-api.careerviet.vn/api/v1/es/jsk/employers';
const SITE = 'https://careerviet.vn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;        // 500 results per query at most
const MAX_PROFILES = 5;     // profile pages fetched per lookup
const WATCHDOG_MS = 55000;  // the whole call must finish in under 60 s

// Legal-form words in folded form (no accents, lower case, single spaces). Longest first.
const LEGAL = [
  'cong ty trach nhiem huu han mot thanh vien', 'cong ty trach nhiem huu han', 'trach nhiem huu han',
  'mot thanh vien', '1 thanh vien', 'cong ty co phan', 'co phan', 'cong ty cp', 'cong ty',
  'tnhh', 'ctcp', 'joint stock company', 'company limited', 'co ltd', 'ltd', 'llc', 'jsc',
  'doanh nghiep tu nhan', 'dntn',
];

const JSON_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };
const HTML_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };

/** Lower-case, no accents, letters and digits only, single spaces. */
function fold(s) {
  return String(s || '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Remove legal-form words from a folded name. */
function stripLegal(folded) {
  let s = ' ' + folded + ' ';
  for (let pass = 0; pass < 2; pass++) {
    for (const p of LEGAL) s = s.split(' ' + p + ' ').join(' ');
  }
  return s.trim().replace(/\s+/g, ' ');
}

/** Comparison keys for a name: the full name, and the name without "(brand)" / "[brand]" parts. */
function matchKeys(name) {
  const full = stripLegal(fold(name)).replace(/ /g, '');
  const noBrackets = stripLegal(fold(String(name || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' '))).replace(/ /g, '');
  return [...new Set([full, noBrackets].filter(Boolean))];
}

function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

function apiUrl(query, page) {
  return `${API}?limit=${PAGE_SIZE}&page=${page}&q=${encodeURIComponent(query)}`;
}

function couldnt(reason, excerpt, sourceUrl) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Run one search query, following pages until the API says there are no more. */
async function searchAll(query) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = apiUrl(query, page);
    const res = await fetch(url, { headers: JSON_HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) {
      return { items, complete: false, error: 'blocked', url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { items, complete: false, error: 'http_error', url, excerpt: `HTTP ${res.status}` };
    }
    const text = await res.text();
    if (/captcha|cf-chl|access denied/i.test(text.slice(0, 2000))) {
      return { items, complete: false, error: 'blocked', url, excerpt: 'bot check page' };
    }
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || body.success !== true || !Array.isArray(body.data)) {
      return { items, complete: false, error: 'layout_changed', url, excerpt: text.slice(0, 200) };
    }
    items.push(...body.data);
    if (!body.metadata || body.metadata.hasNextPage !== true) {
      return { items, complete: true, error: null, url };
    }
  }
  return { items, complete: false, error: null, url: apiUrl(query, MAX_PAGES) };
}

/** Read one employer profile page for the details the search does not return. Never throws. */
async function profileRecord(e) {
  const slug = fold(e.emp_name).replace(/ /g, '-');
  const url = `${SITE}/vi/nha-tuyen-dung/${slug}.${e.emp_id}.html`;
  const rec = {
    name: e.emp_name, emp_id: e.emp_id, address: '', company_size: '', business_type: '',
    website: '', tax_code: '', profile_url: url, profile_status: '',
  };
  try {
    const res = await fetch(url, { headers: HTML_HEADERS, signal: AbortSignal.timeout(25000) });
    rec.profile_url = res.url || url;
    if (!res.ok) { rec.profile_status = `HTTP ${res.status}`; return rec; }
    const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, '');
    const h1 = html.match(/<h1 class="name">([\s\S]*?)<\/h1>/);
    if (h1) rec.name = clean(h1[1]) || rec.name;
    const addr = html.match(/<strong>\s*Địa điểm\s*<\/strong>\s*<p>([\s\S]*?)<\/p>/);
    if (addr) rec.address = clean(addr[1]);
    const size = html.match(/Quy mô công ty\s*:\s*([^<]+)/);
    if (size) rec.company_size = clean(size[1]);
    const biz = html.match(/Loại hình hoạt động\s*:\s*([^<]+)/);
    if (biz) rec.business_type = clean(biz[1]);
    const web = html.match(/\\"emp_website\\":\\"([^\\"]*)\\"/);
    if (web) rec.website = web[1];
    const tax = html.match(/\\"emp_tax_id\\":\\"([^\\"]+)\\"/);
    if (tax) rec.tax_code = tax[1];
    rec.profile_status = h1 ? 'ok' : 'layout_changed: no company name heading';
    return rec;
  } catch (err) {
    rec.profile_status = `error: ${String((err && err.message) || err).slice(0, 120)}`;
    return rec;
  }
}

async function run(keyword) {
  const inputKeys = matchKeys(keyword);
  const folded = stripLegal(fold(keyword));
  if (!inputKeys.length || !folded) {
    return couldnt('other', 'no company name left after removing the legal form', apiUrl('', 1));
  }

  // The search needs the name without the legal form ("CÔNG TY TNHH JOB HOUSE" finds nothing, "JOB HOUSE" finds it).
  // It is also unreliable with accented multi-word names, so if the full name returns nothing, try the longest word once.
  const longest = folded.split(' ').filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0];
  const queries = [folded];
  const found = [];
  const seen = new Set();
  let total = 0;
  let incomplete = '';
  let lastUrl = apiUrl(folded, 1);

  for (let qi = 0; qi < queries.length; qi++) {
    const r = await searchAll(queries[qi]);
    lastUrl = r.url;
    if (r.error) return couldnt(r.error, r.excerpt, r.url);
    total += r.items.length;
    for (const e of r.items) {
      if (!e || !e.emp_id || seen.has(e.emp_id)) continue;
      const siteKeys = matchKeys(e.emp_name);
      if (siteKeys.some((k) => inputKeys.includes(k))) { seen.add(e.emp_id); found.push(e); }
    }
    if (!r.complete) incomplete = `search "${queries[qi]}" stopped after ${MAX_PAGES} pages`;
    if (found.length) break;
    if (qi === 0 && total === 0 && longest && longest !== folded) queries.push(longest);
  }

  if (!found.length) {
    if (incomplete) {
      return couldnt('other', `no exact match, but ${incomplete}, so the list is not complete`, lastUrl);
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: apiUrl(folded, 1),
      excerpt: `0 exact matches for "${keyword}" (searched: ${queries.join(', ')}; ${total} results, none the same company)`,
    };
  }

  const shown = found.slice(0, MAX_PROFILES);
  const records = await Promise.all(shown.map(profileRecord));
  const notes = [];
  if (found.length > MAX_PROFILES) notes.push(`first ${MAX_PROFILES} of ${found.length} matches shown`);
  if (incomplete) notes.push(`${incomplete}; more matches may exist`);
  const names = records.map((r) => `${r.name} (${r.emp_id})`).join('; ');
  return {
    status: 'found',
    reason: '',
    records,
    source_url: records[0].profile_url,
    excerpt: [names, notes.join('; ')].filter(Boolean).join(' | ').slice(0, 300),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => resolve(couldnt('timeout', 'the lookup did not finish in 55 s', apiUrl(keyword, 1))), WATCHDOG_MS);
  });
  try {
    return await Promise.race([run(String(keyword || '')), watchdog]);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', String((err && err.message) || err), apiUrl(String(keyword || ''), 1));
  } finally {
    clearTimeout(timer);
  }
}
