export const meta = {
  task: 'KR-albamon.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_name', 'representative', 'business_item', 'address', 'establish_date', 'employee_count',
    'capital', 'sales', 'company_type', 'listed', 'homepage', 'albamon_certified', 'certified_date', 'company_id'],
  canary: { found: '㈜GS티에스', not_found: '가나다라마바사아자차카타파하거너더러' },
};

// Albamon has no company registry. Its job-ad search (total-search) lists ads with the employer name as written by
// the employer, and each ad's job page embeds an employer profile. Both are read from the Next.js JSON in the HTML.

const BASE = 'https://www.albamon.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_PAGES = 4;   // 4 pages x 20 ads = the first 80 ads; fetched together (one round)
const DETAIL_MAX = 5;     // job pages read for the profile; fetched together (second round)

// Legal-form words and marks used in Korean and English company names. Removed before names are compared.
const LEGAL_FORM = /(주식회사|유한회사|합자회사|합명회사|유한책임회사|사단법인|재단법인|사회적협동조합|농업회사법인|\(주\)|\(유\)|\(사\)|\(재\)|㈲|㈔|\b(?:co\.?\s*,?\s*ltd\.?|inc\.?|corp\.?|corporation|limited|llc)(?=\W|$))/gi;

function clean(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Name used to compare companies: NFKC, no legal form, no spaces or punctuation, lower case. */
function coreName(s) {
  return clean(s).replace(LEGAL_FORM, ' ').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

/** The keyword sent to the site's search: the name with the legal form taken out, spacing kept. */
function searchTerm(keyword) {
  const t = clean(keyword).replace(LEGAL_FORM, ' ').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return t || clean(keyword);
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: clean(excerpt).slice(0, 300) };
}

function classify(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

async function getHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: failure('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: failure('http_error', url, `HTTP ${res.status}`) };
  return { html: await res.text() };
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function noDataFailure(html, url) {
  const text = clean(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '));
  if (/captcha|보안문자|access denied|접근이 제한/i.test(text)) return failure('blocked', url, text);
  return failure('layout_changed', url, text);
}

/** One page of job-ad search results. */
async function searchPage(term, page) {
  const url = `${BASE}/total-search?keyword=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`;
  const got = await getHtml(url);
  if (got.fail) return { fail: got.fail };
  const q = nextData(got.html)?.props?.pageProps?.dehydratedState?.queries?.find((x) => x?.state?.data?.base);
  const base = q?.state?.data?.base;
  if (!base || !Array.isArray(base.normal?.collection) || !base.pagination) return { fail: noDataFailure(got.html, url) };
  return { url, items: base.normal.collection, total: Number(base.pagination.totalCount) || 0 };
}

/** The job page of one ad; it embeds the employer profile (companyData). */
async function jobPage(id) {
  const url = `${BASE}/jobs/detail/${id}`;
  const got = await getHtml(url);
  if (got.fail) return { fail: got.fail };
  const data = nextData(got.html)?.props?.pageProps?.data;
  const c = data?.companyData;
  if (!c || !clean(c.companyName)) return { fail: noDataFailure(got.html, url) };
  return { id, url, company: c, history: data.companyHistories || {} };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = (term) => `${BASE}/total-search?keyword=${encodeURIComponent(term)}`;
  try {
    const kw = clean(keyword);
    if (!kw) return failure('other', BASE, 'empty company name');
    const term = searchTerm(kw);
    const want = coreName(kw);
    if (!want) return failure('other', searchUrl(term), 'company name has no letters or digits');

    // Round 1: the first pages of job-ad results, fetched together.
    const pages = await Promise.all(Array.from({ length: SEARCH_PAGES }, (_, i) =>
      searchPage(term, i + 1).catch((e) => ({ fail: failure(classify(e), searchUrl(term), String(e?.message || e)) }))));
    const bad = pages.find((p) => p.fail);
    if (bad) return bad.fail;

    const url = pages[0].url.replace(/&page=\d+$/, '');
    const total = pages[0].total;
    const seen = pages.flatMap((p) => p.items);
    const matches = seen.filter((ad) => coreName(ad.companyName) === want);

    if (!matches.length) {
      if (total > seen.length) {
        return failure('other', url, `no ad with this exact company name among the first ${seen.length} of ${total} job ads; the rest were not checked`);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `0 of ${total} job ads on the site are posted under this company name`,
      };
    }

    // Round 2: the employer profile on the job pages of the matching ads, fetched together.
    // An ad can carry a name that is not its employer (a brand name), so the profile name must match too.
    const allAdIds = [...new Set(matches.map((ad) => ad.recruitNo))];
    const adIds = allAdIds.slice(0, DETAIL_MAX);
    const jobs = await Promise.all(adIds.map((id) =>
      jobPage(id).catch((e) => ({ fail: failure(classify(e), `${BASE}/jobs/detail/${id}`, String(e?.message || e)) }))));
    const ok = jobs.filter((j) => j.company);
    if (!ok.length) return jobs.find((j) => j.fail).fail;

    const verified = ok.filter((j) => coreName(j.company.companyName) === want);
    if (!verified.length) {
      const failed = jobs.find((j) => j.fail);
      if (failed) return failed.fail;
      if (allAdIds.length > adIds.length) {
        return failure('other', `${BASE}/jobs/detail/${adIds[0]}`,
          `${allAdIds.length} ads carry this name; the employer of the first ${adIds.length} is not this company; the rest were not checked`);
      }
      const employers = [...new Set(ok.map((j) => clean(j.company.companyName)))].join(' ; ');
      return {
        status: 'not_found', reason: '', records: [], source_url: `${BASE}/jobs/detail/${ok[0].id}`,
        excerpt: `${allAdIds.length} job ad(s) show this name, but their employer profile is another company: ${employers}`,
      };
    }

    const records = [];
    const doneKeys = new Set();
    for (const j of verified) {
      const c = j.company;
      const h = j.history;
      const key = clean(c.companyId) || `${coreName(c.companyName)}|${clean(c.address)}`;
      if (doneKeys.has(key)) continue;
      doneKeys.add(key);
      const ad = matches.find((m) => m.recruitNo === j.id);
      records.push({
        name: clean(ad?.companyName),
        company_name: clean(c.companyName),
        representative: clean(c.representativeName),
        business_item: clean(c.businessItem),
        address: clean(c.fullAddress || c.address),
        establish_date: clean(c.establishDate),
        employee_count: clean(c.employeeCount),
        capital: clean(c.capitalAmount),
        sales: clean(c.salesAmount),
        company_type: clean(c.companyTypeDescription?.description),
        listed: clean(c.listedCompanyTypeDescription?.description),
        homepage: clean(c.companyHomepage),
        albamon_certified: h.companyCertificationState === true,
        certified_date: clean(h.companyCertificationDate),
        company_id: clean(c.companyId),
      });
    }

    const first = records[0];
    const failedJobs = jobs.filter((j) => j.fail).length;
    const excerpt = `${first.company_name} | 대표 ${first.representative} | ${first.business_item} | ${first.address}` +
      (failedJobs ? ` (${failedJobs} of ${adIds.length} job pages could not be read)` : '');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: verified[0].url,
      excerpt,
    };
  } catch (err) {
    return failure('other', searchUrl(searchTerm(keyword || '')), String(err?.message || err));
  }
}
