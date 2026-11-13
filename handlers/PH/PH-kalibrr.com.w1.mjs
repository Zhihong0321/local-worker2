export const meta = { task: 'PH-kalibrr.com', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'code', 'country_code', 'visible', 'verified', 'industry', 'jobs_count', 'profile_url'],
  canary: { found: 'Ayala Land Inc.', not_found: 'Kooperatiba ng Masasayang Tindahan Inc.' } };

const BASE = 'https://www.kalibrr.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NOT_FOUND_MARK = 'Page not available in our platform';
const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
// Legal-form words that Kalibrr profile addresses often leave out ("PLDT Inc." -> /c/pldt).
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'plc',
  'pte', 'sdn', 'bhd', 'berhad', 'opc', 'llp', 'the']);
const PRIORITY = ['blocked', 'http_error', 'layout_changed', 'timeout', 'other'];

function words(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Normalised name for comparison: case, punctuation, accents and legal form removed. */
function nameKey(s) {
  const w = words(s);
  const core = w.filter((t) => !LEGAL.has(t));
  return (core.length ? core : w).join(' ');
}

/** Profile addresses to try: full name and name without legal form, each with -1 and -2 (duplicate profiles). */
function candidateSlugs(name) {
  const full = words(name).join('-');
  const core = nameKey(name).replace(/ /g, '-');
  const out = [];
  for (const base of [full, core]) {
    if (!base) continue;
    for (const suffix of ['', '-1', '-2']) out.push(base + suffix);
  }
  return [...new Set(out)];
}

function plainText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** One profile address. Returns profile | absent | error (with a reason). Never throws. */
async function probe(url) {
  let res;
  let body;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25000),
    });
    body = await res.text();
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { kind: 'error', reason: timeout ? 'timeout' : 'other', url, excerpt: String(err?.message || err).slice(0, 200) };
  }
  const m = body.match(NEXT_DATA);
  let company = null;
  if (m) {
    try { company = JSON.parse(m[1])?.props?.pageProps?.company ?? null; } catch { company = null; }
  }
  if (res.status === 403 || res.status === 429) {
    return { kind: 'error', reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
  }
  if (res.status === 404 && body.includes(NOT_FOUND_MARK)) return { kind: 'absent', url };
  if (!res.ok) return { kind: 'error', reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
  if (!company || typeof company.name !== 'string') {
    if (body.includes(NOT_FOUND_MARK)) return { kind: 'absent', url };
    if (!m && /captcha|cf-chl|just a moment/i.test(body)) return { kind: 'error', reason: 'blocked', url, excerpt: 'bot check page' };
    return { kind: 'error', reason: 'layout_changed', url, excerpt: plainText(body) };
  }
  return { kind: 'profile', url, company };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = typeof keyword === 'string' ? keyword.trim() : '';
    const slugs = candidateSlugs(name);
    if (!slugs.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no address can be built from this name' };
    }
    if (slugs.some((s) => !/^[a-z0-9-]+$/.test(s))) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE,
        excerpt: 'name has letters that Kalibrr profile addresses do not use' };
    }

    const results = await Promise.all(slugs.map((s) => probe(`${BASE}/c/${s}/jobs`)));
    const key = nameKey(name);
    const hits = results.filter((r) => r.kind === 'profile' && nameKey(r.company.name) === key);

    if (hits.length) {
      const seen = new Set();
      const records = [];
      for (const h of hits) {
        const c = h.company;
        const id = c.code || h.url;
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({
          name: c.name,
          code: c.code ?? '',
          country_code: c.countryCode ?? '',
          visible: c.visible ?? null,
          verified: c.verified ?? null,
          industry: c.industry ?? null,
          jobs_count: c.jobsInfo?.totalCount ?? null,
          profile_url: h.url,
        });
      }
      return {
        status: 'found', reason: '', records, source_url: hits[0].url,
        excerpt: `Kalibrr profile "${hits[0].company.name}" (code ${hits[0].company.code})`,
      };
    }

    // Any address that could not be read means we cannot say the company is absent.
    const errors = results.filter((r) => r.kind === 'error')
      .sort((a, b) => PRIORITY.indexOf(a.reason) - PRIORITY.indexOf(b.reason));
    if (errors.length) {
      const e = errors[0];
      return { status: 'couldnt_check', reason: e.reason, records: [], source_url: e.url, excerpt: e.excerpt };
    }

    return {
      status: 'not_found', reason: '', records: [], source_url: `${BASE}/c/${slugs[0]}/jobs`,
      excerpt: `No Kalibrr profile named "${name}" at /c/<slug>/jobs for: ${slugs.join(', ')}`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: String(err?.message || err).slice(0, 200) };
  }
}
