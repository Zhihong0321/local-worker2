export const meta = {
  task: 'CA-health-products.canada.ca',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['registry', 'company', 'din', 'product', 'status', 'class', 'schedule', 'active_ingredients', 'strengths', 'company_id', 'address'],
  canary: { found: 'PFIZER CANADA ULC', not_found: 'Zzqxvb Farmaceutique Inexistante' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DPD_FORM = 'https://health-products.canada.ca/dpd-bdpp/newSearch';
const DPD_SEARCH = 'https://health-products.canada.ca/dpd-bdpp/search-recherche';
const MD_FORM = 'https://health-products.canada.ca/mdall-limh/prepareSearch?&type=active&lang=eng';
const MD_SEARCH = 'https://health-products.canada.ca/mdall-limh/search';
const LEGAL = new Set(['inc', 'incorporated', 'ltd', 'limited', 'ulc', 'ltee', 'corp', 'corporation', 'co', 'company',
  'llc', 'lp', 'llp', 'plc', 'gmbh', 'sa', 'sas', 'sarl', 'bv', 'ag', 'srl', 'spa', 'pty', 'pvt', 'nv', 'oy', 'ab', 'kk',
  'sdn', 'bhd', 'lc']);

function cleanText(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;/gi, "'").replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

// Normalised word tokens: case, accents, punctuation and trailing legal form removed.
function baseTokens(s) {
  const t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const toks = t ? t.split(' ') : [];
  while (toks.length > 1 && LEGAL.has(toks[toks.length - 1])) toks.pop();
  return toks;
}

function sameName(a, b) {
  const x = baseTokens(a).join(' ');
  return x.length > 0 && x === baseTokens(b).join(' ');
}

// Search term sent to the site: original spelling, punctuation removed, trailing legal form removed.
function searchTerm(keyword, max) {
  const raw = String(keyword || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const toks = raw ? raw.split(' ') : [];
  const norm = (w) => w.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  while (toks.length > 1 && LEGAL.has(norm(toks[toks.length - 1]))) toks.pop();
  return toks.join(' ').slice(0, max);
}

// One request, following redirects by hand so the cookies can be carried along.
async function call(url, init, jar) {
  let cur = url;
  let opts = { ...init, redirect: 'manual' };
  for (let hop = 0; hop < 4; hop++) {
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8', ...(opts.headers || {}) };
    if (jar.size) headers.Cookie = [...jar.values()].join('; ');
    const res = await fetch(cur, { ...opts, headers, signal: AbortSignal.timeout(25000) });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      jar.set(kv.split('=')[0], kv);
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).href;
      opts = { method: 'GET', redirect: 'manual' };
      continue;
    }
    return { status: res.status, url: cur, body: await res.text() };
  }
  throw new Error('too many redirects');
}

function refusal(r, source) {
  if (r.status === 403 || r.status === 429) return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: source, excerpt: `HTTP ${r.status}` };
  if (r.status !== 200) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: source, excerpt: `HTTP ${r.status}` };
  if (r.body.length < 4000 && /captcha|access denied/i.test(r.body)) return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: source, excerpt: 'bot or captcha page' };
  return null;
}

function failure(err, source) {
  const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
  return { status: 'couldnt_check', reason, records: [], source_url: source, excerpt: String(err && err.message || err).slice(0, 200) };
}

function tableRows(body) {
  const table = body.match(/<table[^>]*id="results"[\s\S]*?<\/table>/i);
  if (!table) return null;
  return table[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
}

function rowCells(row) {
  return (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(cleanText);
}

/* ---------- DPD: Drug Product Database (drugs), form POST with a CSRF token ---------- */
async function searchDpd(keyword) {
  const jar = new Map();
  try {
    const form = await call(DPD_FORM, {}, jar);
    const bad = refusal(form, DPD_FORM);
    if (bad) return bad;
    const csrf = form.body.match(/name="_csrf" value="([^"]+)"/);
    if (!csrf) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DPD_FORM, excerpt: 'no _csrf token on the search form' };

    const term = searchTerm(keyword, 80);
    const body = new URLSearchParams({
      _csrf: csrf[1], companyName: term,
      _status: '1', status: '0', _drugClass: '1', drugClass: '0', _route: '1', route: '0',
      _dosage: '1', dosage: '0', _schedule: '1', schedule: '0', _vetSpecies: '1', vetSpecies: '0',
      _biosimDrugSearch: 'on',
    });
    const post = await call(DPD_SEARCH, { method: 'POST', body, headers: { Referer: DPD_FORM } }, jar);
    const bad2 = refusal(post, DPD_FORM);
    if (bad2) return bad2;

    if (/No match found|does not match with any of the products/i.test(post.body)) {
      return { status: 'not_found', reason: '', records: [], source_url: DPD_FORM, excerpt: `DPD: no match found for "${term}"` };
    }
    const rows = tableRows(post.body);
    if (!rows || rows.length === 0) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: post.url, excerpt: 'DPD results table not found' };

    const header = rowCells(rows[0]);
    const col = (name) => header.findIndex((h) => h.toLowerCase().startsWith(name));
    const cStatus = col('status'), cDin = col('din'), cCompany = col('company'), cProduct = col('product'),
      cClass = col('class'), cSched = col('schedule'), cAi = col('a.i. name'), cStrength = col('strength');
    if (cDin < 0 || cCompany < 0 || cProduct < 0) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: post.url, excerpt: 'DPD header: ' + header.join(' | ').slice(0, 200) };

    const byDin = new Map();
    for (const row of rows.slice(1)) {
      const c = rowCells(row);
      const company = c[cCompany] || '';
      if (!company || !sameName(company, keyword)) continue;
      const din = c[cDin] || '';
      if (!byDin.has(din)) {
        byDin.set(din, { registry: 'DPD', company, din, product: c[cProduct] || '', status: c[cStatus] || '',
          class: c[cClass] || '', schedule: [], active_ingredients: [], strengths: [] });
      }
      const rec = byDin.get(din);
      const add = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };
      add(rec.schedule, c[cSched]);
      add(rec.active_ingredients, c[cAi]);
      add(rec.strengths, c[cStrength]);
    }
    const records = [...byDin.values()];
    if (records.length === 0) return { status: 'not_found', reason: '', records: [], source_url: DPD_FORM, excerpt: `DPD: ${rows.length - 1} result rows, none for this company` };
    const first = records[0];
    return { status: 'found', reason: '', records, source_url: DPD_FORM,
      excerpt: `DPD: ${first.company}, ${records.length} DIN(s), e.g. ${first.din} ${first.product} (${first.status})` };
  } catch (err) {
    return failure(err, DPD_FORM);
  }
}

/* ---------- MDALL: Medical Devices Active Licence Listing, form POST with a CSRF token ---------- */
function infoFields(body) {
  const t = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const lines = t.replace(/<[^>]+>/g, '\n').split('\n').map(cleanText).filter(Boolean);
  const i = lines.findIndex((x) => x === 'Manufacturer');
  if (i < 0 || !lines[i + 1]) return null;
  const address = [];
  for (let k = i + 2; k < lines.length && address.length < 4 && !/^Company ID/i.test(lines[k]); k++) address.push(lines[k]);
  return { name: lines[i + 1], address: address.join(', ') };
}

async function searchMdall(keyword) {
  const jar = new Map();
  try {
    const form = await call(MD_FORM, {}, jar);
    const bad = refusal(form, MD_FORM);
    if (bad) return bad;
    const csrf = form.body.match(/name="_csrf" value="([^"]+)"/);
    if (!csrf) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: MD_FORM, excerpt: 'no _csrf token on the search form' };

    const term = searchTerm(keyword, 50);
    const body = new URLSearchParams({ _csrf: csrf[1], option: '0', name: term });
    const post = await call(MD_SEARCH, { method: 'POST', body, headers: { Referer: MD_FORM } }, jar);
    const bad2 = refusal(post, MD_FORM);
    if (bad2) return bad2;

    if (/No Match found/i.test(post.body)) {
      return { status: 'not_found', reason: '', records: [], source_url: MD_FORM, excerpt: `MDALL: no match found for "${term}"` };
    }
    const rows = tableRows(post.body);
    if (!rows) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: post.url, excerpt: 'MDALL results table not found' };

    // Search rows carry name and address in one cell; keep the rows whose leading words are the company name,
    // then read the clean legal name from each company's information page before comparing.
    const kwTokens = baseTokens(keyword);
    const ids = new Set();
    for (const row of rows.slice(1)) {
      const id = (row.match(/companyId=(\d+)/i) || [])[1];
      const cell = (row.match(/<td[\s\S]*?<\/td>/i) || [''])[0];
      const cellTokens = baseTokens(cleanText(cell));
      if (id && kwTokens.length && kwTokens.every((t, i) => cellTokens[i] === t)) ids.add(id);
    }
    if (ids.size === 0) return { status: 'not_found', reason: '', records: [], source_url: MD_FORM, excerpt: `MDALL: ${rows.length - 1} result rows, none starts with this name` };

    const infos = await Promise.all([...ids].map(async (id) => {
      const url = `https://health-products.canada.ca/mdall-limh/information?lang=eng&companyId=${id}`;
      try {
        const r = await call(url, {}, new Map());
        if (r.status !== 200) return { id, url, error: `HTTP ${r.status}` };
        const f = infoFields(r.body);
        return f ? { id, url, ...f } : { id, url, error: 'no Manufacturer field' };
      } catch (err) {
        return { id, url, error: String(err && err.message || err).slice(0, 120) };
      }
    }));

    const matches = infos.filter((x) => !x.error && sameName(x.name, keyword));
    const unreadable = infos.filter((x) => x.error);
    if (matches.length === 0) {
      if (unreadable.length) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: unreadable[0].url, excerpt: `MDALL info page: ${unreadable[0].error}` };
      return { status: 'not_found', reason: '', records: [], source_url: MD_FORM, excerpt: `MDALL: ${ids.size} similar companies, none with this exact name` };
    }
    const records = matches.map((m) => ({ registry: 'MDALL', company: m.name, company_id: m.id, address: m.address }));
    return { status: 'found', reason: '', records, source_url: matches[0].url,
      excerpt: `MDALL: ${matches[0].name}, company ID ${matches[0].id}, ${matches[0].address}` };
  } catch (err) {
    return failure(err, MD_FORM);
  }
}

function combine(dpd, md) {
  const found = [dpd, md].filter((r) => r.status === 'found');
  if (found.length) {
    return { status: 'found', reason: '', records: found.flatMap((r) => r.records),
      source_url: found.map((r) => r.source_url).join(' | '), excerpt: found.map((r) => r.excerpt).join(' | ').slice(0, 500) };
  }
  if (dpd.status === 'not_found' && md.status === 'not_found') {
    return { status: 'not_found', reason: '', records: [], source_url: `${DPD_FORM} | ${MD_FORM}`,
      excerpt: `${dpd.excerpt} | ${md.excerpt}`.slice(0, 500) };
  }
  const bad = [dpd, md].find((r) => r.status === 'couldnt_check' && r.reason === 'blocked')
    || [dpd, md].find((r) => r.status === 'couldnt_check');
  return { status: 'couldnt_check', reason: bad.reason, records: [], source_url: bad.source_url,
    excerpt: `DPD: ${dpd.status}/${dpd.reason || ''} ${dpd.excerpt} | MDALL: ${md.status}/${md.reason || ''} ${md.excerpt}`.slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: DPD_FORM, excerpt: 'empty company name' };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'couldnt_check', reason: 'timeout', records: [], source_url: DPD_FORM,
      excerpt: 'the lookup did not finish in 55 s' }), 55000);
  });
  try {
    const run = Promise.all([searchDpd(kw), searchMdall(kw)]).then(([dpd, md]) => combine(dpd, md));
    return await Promise.race([run, deadline]);
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: DPD_FORM, excerpt: String(err && err.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
