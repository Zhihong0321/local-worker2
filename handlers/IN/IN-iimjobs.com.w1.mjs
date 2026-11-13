export const meta = {
  task: 'IN-iimjobs.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'company_type', 'primary_industry', 'founded_year', 'total_employees', 'total_employees_india', 'hq', 'office_locations', 'nature_of_business', 'page_url', 'about'],
  canary: { found: 'Infosys', not_found: 'Zelvorna Quillmar Industries Pvt Ltd' },
};

const SITE = 'https://www.iimjobs.com';
const SITEMAP = `${SITE}/revamp_sitemap-company-1.xml.gz`;
const SUFFIX = '-careers';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};
// Legal-form words that are dropped before comparing names ("Infosys Limited" == "Infosys").
const LEGAL_WORDS = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'co', 'company', 'corporation', 'corp', 'opc', 'plc', 'the']);

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Comparison key: lower case, letters and digits only, legal-form words removed. */
function nameKey(text) {
  return stripAccents(text)
    .toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join('');
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Reads one company page (its profile is embedded as JSON in the page). Returns { record } or { error }. */
async function readCompany(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { error: fail('blocked', url, `HTTP ${res.status}`) };
    if (!res.ok) return { error: fail('http_error', url, `HTTP ${res.status}`) };
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return { error: fail('layout_changed', url, html.slice(0, 300)) };
    let pp;
    try {
      pp = JSON.parse(m[1]).props.pageProps;
    } catch {
      return { error: fail('layout_changed', url, 'page data could not be read') };
    }
    if (pp?.initialState?.botDetection?.captchaShown) return { error: fail('blocked', url, 'captcha shown') };
    const ab = pp.ambitionBoxData || null;
    const title = String(pp.seoConfig?.title || '').split(/ Careers/i)[0].trim();
    if (!ab && !title) return { error: fail('layout_changed', url, 'company page has no company data') };
    const offices = ab?.officeLocations ? [...new Set(ab.officeLocations.map((o) => clean(o.cityName)).filter(Boolean))] : [];
    return {
      record: {
        name: ab?.companyName || title,
        company_id: pp.companyId ?? null,
        company_type: ab?.companyType || '',
        primary_industry: ab?.primaryIndustry || '',
        founded_year: ab?.foundedYear || '',
        total_employees: ab?.totalEmployees || '',
        total_employees_india: ab?.totalEmployeesIndia || '',
        hq: ab?.hq || '',
        office_locations: offices,
        nature_of_business: ab?.natureOfBusiness || [],
        page_url: url,
        about: clean(ab?.aboutCompany).slice(0, 300),
      },
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { error: fail(timedOut ? 'timeout' : 'other', url, String(err?.message || err)) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    const key = nameKey(input);
    const base = stripAccents(input);
    // The site lists companies in Latin script only; a name in another script cannot be matched.
    const foreign = [...base].some((ch) => /\p{L}/u.test(ch) && !/[a-z]/i.test(ch));
    if (foreign) return fail('other', SITEMAP, `"${input}" has letters outside the Latin alphabet; the site lists companies in Latin script, so it cannot be matched`);
    if (!key) return fail('other', SITEMAP, `no usable name in "${input}"`);

    // Step 1: the site's own list of company pages (one URL per company, slug = name).
    const sres = await fetch(SITEMAP, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (sres.status === 403 || sres.status === 429) return fail('blocked', SITEMAP, `HTTP ${sres.status}`);
    if (!sres.ok) return fail('http_error', SITEMAP, `HTTP ${sres.status}`);
    const xml = await sres.text();
    if (!xml.includes('<urlset')) return fail('layout_changed', SITEMAP, xml.slice(0, 300));

    const all = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1])
      .filter((u) => u.startsWith(`${SITE}/`) && u.endsWith(SUFFIX));
    const matches = [...new Set(all.filter((u) => nameKey(u.slice(SITE.length + 1, u.length - SUFFIX.length)) === key))];

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SITEMAP,
        excerpt: `No company page matches "${input}" (company list has ${all.length} entries)`,
      };
    }

    // Step 2: read the matching company pages (at most 3, in parallel, so the call stays under 60 s).
    const shown = matches.slice(0, 3);
    const results = await Promise.all(shown.map(readCompany));
    const bad = results.find((r) => r.error);
    if (bad) return bad.error;

    const records = results.map((r) => r.record);
    const more = matches.length > shown.length ? `; ${matches.length - shown.length} more matches not read` : '';
    return {
      status: 'found', reason: '', records, source_url: shown[0],
      excerpt: `${records.length} company page(s): ${records.map((r) => `${r.name} (${r.hq || 'HQ not listed'})`).join('; ')}${more}`.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', SITEMAP, String(err?.message || err));
  }
}
