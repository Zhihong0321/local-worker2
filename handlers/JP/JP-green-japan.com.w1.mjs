export const meta = {
  task: 'JP-green-japan.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'fullName', 'company_id', 'title', 'address', 'capital', 'established', 'employees', 'president', 'stock', 'industry', 'profile_url'],
  canary: { found: '株式会社 HACHI', not_found: '株式会社ミツケラレナイ商事テスト' },
};

const SITE = 'https://www.green-japan.com';
const SEARCH = SITE + '/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' };
const MAX_SEARCH_PAGES = 2;
const OVERALL_MS = 55000;

/** Remove Japanese and Latin legal-form words (株式会社, (株), Co., Ltd., Inc. ...). */
function stripLegalForm(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|相互会社/g, ' ')
    .replace(/\((株|有|同|合)\)/g, ' ')
    .replace(/\b(co\.?\s*,?\s*ltd|inc|llc|corp|corporation|ltd|k\.k)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare-only form of a name: no legal form, no case, no spaces or punctuation. */
function normalize(s) {
  return stripLegalForm(s)
    .toLowerCase()
    .replace(/[\s・·•.,，、。・･'"‘’“”()（）\[\]「」『』\-‐‑–—_\/&＆!！?？:：;；]/g, '');
}

function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function nameOf(v) {
  if (v && typeof v === 'object') return String(v.name || '');
  return v == null ? '' : String(v);
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function get(url) {
  return fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
}

async function lookupInner(keyword) {
  const want = normalize(keyword);
  const core = stripLegalForm(keyword) || String(keyword).trim();
  const searchUrl = (page) => `${SEARCH}?keyword=${encodeURIComponent(core)}${page > 1 ? `&page=${page}` : ''}`;

  const matches = [];
  let totalJobs = 0;
  let totalCompanies = 0;
  let pagesChecked = 0;

  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const url = searchUrl(page);
    const res = await get(url);
    if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

    const html = await res.text();
    pagesChecked++;
    const data = parseNextData(html);
    if (!data) {
      if (/captcha|cf-chl|Just a moment|Attention Required/i.test(html)) return fail('blocked', url, 'bot check page');
      return fail('layout_changed', url, html.slice(0, 200));
    }
    const sr = data && data.props && data.props.pageProps && data.props.pageProps.defaultSearchJobOfferData;
    if (!sr || !Array.isArray(sr.jobOffers)) return fail('layout_changed', url, 'no defaultSearchJobOfferData');

    if (page === 1) {
      totalJobs = Number(sr.totalJobOfferCount) || 0;
      totalCompanies = Number(sr.totalCompanyCount) || 0;
    }
    for (const job of sr.jobOffers) {
      const c = job && job.company;
      if (!c || c.id == null) continue;
      if (normalize(c.name) === want && !matches.some((m) => m.id === String(c.id))) {
        matches.push({ id: String(c.id), name: String(c.name) });
      }
    }
    if (matches.length || sr.jobOffers.length === 0 || page * 20 >= totalJobs) break;
  }

  if (!matches.length) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl(1),
      excerpt: `Green search "${core}": ${totalJobs} jobs from ${totalCompanies} companies, none named "${keyword}" (${pagesChecked} page(s) checked)`,
    };
  }

  const records = [];
  let firstUrl = '';
  let detailNote = '';
  for (const m of matches) {
    const url = `${SITE}/company/${m.id}`;
    if (!firstUrl) firstUrl = url;
    const rec = { name: m.name, fullName: '', company_id: m.id, title: '', address: '', capital: '', established: '',
      employees: '', president: '', stock: '', industry: '', profile_url: url };
    try {
      const res = await get(url);
      if (res.ok) {
        const data = parseNextData(await res.text());
        const cl = data && data.props && data.props.pageProps && data.props.pageProps.client;
        if (cl) {
          rec.fullName = cl.fullName || '';
          rec.title = cl.title || '';
          rec.address = cl.address || '';
          rec.capital = cl.capital || '';
          const ts = Number(cl.establishTimestamp);
          // Site stores midnight JST as a unix time; shift by +9 h before taking the date.
          if (ts) rec.established = new Date((ts + 32400) * 1000).toISOString().slice(0, 10);
          rec.employees = cl.employees == null ? '' : String(cl.employees);
          rec.president = cl.presidentName || '';
          rec.stock = nameOf(cl.stock);
          rec.industry = Array.isArray(cl.industryTypes) ? cl.industryTypes.map(nameOf).join(' / ') : '';
        } else {
          detailNote = 'company page had no client data';
        }
      } else {
        detailNote = `company page HTTP ${res.status}`;
      }
    } catch (err) {
      detailNote = 'company page not read: ' + String((err && err.message) || err).slice(0, 100);
    }
    records.push(rec);
  }

  return {
    status: 'found',
    reason: '',
    records,
    source_url: firstUrl,
    excerpt: `Green: ${records.length} company match(es) for "${keyword}"` + (detailNote ? ` (${detailNote})` : ''),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const src = SEARCH + '?keyword=' + encodeURIComponent(String(keyword || '').trim());
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fail('timeout', src, 'the lookup did not finish in 55 s')), OVERALL_MS);
  });
  try {
    if (!String(keyword || '').trim()) return fail('other', src, 'empty company name');
    return await Promise.race([lookupInner(keyword), deadline]);
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return fail(reason, src, (err && err.message) || err);
  } finally {
    clearTimeout(timer);
  }
}
