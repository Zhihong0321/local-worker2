export const meta = {
  task: 'ID-jobstreet.co.id',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'slug', 'industry', 'company_size', 'primary_location', 'review_rating', 'review_count', 'profile_url'],
  canary: { found: 'Telkom Akses', not_found: 'PT Zzqxvorn Nusantara Sejahtera' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE = 'https://id.jobstreet.com';
// Zone of the Indonesian company pages (window.__CONFIG_STATE__.zone on the company search page).
const ZONE = 'asia-4';
const LIMIT = 50;
const MAX_DETAIL = 3;

// The same GraphQL operation the company search page sends to its own /graphql endpoint.
const GQL = 'query SearchCompanies($name: String!, $includeBranding: Boolean!, $limit: Int, $zone: Zone, $published: Boolean) { searchCompanyProfilesByName(name: $name, includeBranding: $includeBranding, limit: $limit, zone: $zone, published: $published) { companyId data { name slug published reviewCount reviewRating } organisationId zone } }';

// Legal forms are ignored when comparing names, so "PT Telkom Akses Tbk" and "Telkom Akses" are the same company.
const LEGAL = new Set(['pt', 'tbk', 'cv', 'ud', 'persero', 'perseroan', 'terbatas', 'terbuka', 'ltd', 'limited', 'pte', 'sdn', 'bhd', 'llc', 'plc', 'inc']);

function fold(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameKey(s) {
  return fold(s).split(' ').filter((t) => t && !LEGAL.has(t)).join('');
}

function toLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** One matched company: the search fields, plus the profile page fields when the page can be read. Never throws. */
async function detail(match) {
  const d = match.data || {};
  const rec = {
    name: d.name || '',
    company_id: String(match.companyId ?? ''),
    slug: d.slug || '',
    industry: '',
    company_size: '',
    primary_location: '',
    review_rating: d.reviewRating ?? null,
    review_count: d.reviewCount ?? null,
    profile_url: d.slug ? `${SITE}/companies/${d.slug}` : '',
  };
  if (!rec.profile_url) return rec;
  try {
    const res = await fetch(rec.profile_url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { ...rec, detail_error: `profile HTTP ${res.status}` };
    const lines = toLines(await res.text());
    const at = lines.indexOf('Company Profile');
    if (at < 0) return { ...rec, detail_error: 'profile block not found' };
    const field = (label) => {
      const i = lines.indexOf(label, at);
      return i >= 0 && i + 1 < lines.length ? lines[i + 1] : '';
    };
    return {
      ...rec,
      industry: field('Industry'),
      company_size: field('Company size'),
      primary_location: field('Primary location'),
    };
  } catch (err) {
    return { ...rec, detail_error: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short settle wait before returning avoids a Windows Node 24 abort (libuv UV_HANDLE_CLOSING, exit 127)
 * that happens when the runner calls process.exit right after a keep-alive fetch finishes.
 */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const input = String(keyword || '').trim();
  const searchUrl = `${SITE}/companies/search?keyword=${encodeURIComponent(input)}`;
  try {
    const key = nameKey(input);
    if (!key) return couldnt('other', searchUrl, 'the name has no letters or digits to search for');

    // Search with the name minus its legal form; the exact comparison below still uses the full key.
    const searchName = input.split(/\s+/).filter((w) => !LEGAL.has(fold(w))).join(' ') || input;

    const res = await fetch(`${SITE}/graphql`, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        operationName: 'SearchCompanies',
        query: GQL,
        variables: { name: searchName, includeBranding: false, limit: LIMIT, published: true, zone: ZONE },
      }),
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.text();

    if (res.status === 403 || res.status === 429) return couldnt('blocked', searchUrl, `HTTP ${res.status} from the company search`);
    if (!res.ok) return couldnt('http_error', searchUrl, `HTTP ${res.status} from the company search`);

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      if (/captcha|cf-chl|challenge-platform|verify you are human|access denied/i.test(body)) {
        return couldnt('blocked', searchUrl, 'a bot check page came back instead of search results');
      }
      return couldnt('layout_changed', searchUrl, body.slice(0, 300));
    }

    const list = json?.data?.searchCompanyProfilesByName;
    if (!Array.isArray(list)) {
      if (json?.errors?.length) {
        return couldnt('other', searchUrl, 'search returned errors: ' + String(json.errors[0]?.message || '').slice(0, 300));
      }
      return couldnt('layout_changed', searchUrl, 'the search answer has no company list: ' + body.slice(0, 200));
    }

    const matches = list.filter((e) => e?.data && nameKey(e.data.name) === key);
    if (matches.length === 0) {
      if (list.length >= LIMIT) {
        return couldnt('other', searchUrl, `${list.length} results came back (the limit) and none matched exactly, so absence is not proven`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `0 exact name matches among ${list.length} search results for "${searchName}"`,
      };
    }

    const records = await Promise.all(matches.slice(0, MAX_DETAIL).map(detail));
    const excerpt = records
      .map((r) => [r.name, r.industry && `Industry: ${r.industry}`, r.company_size && `Company size: ${r.company_size}`,
        r.primary_location && `Primary location: ${r.primary_location}`].filter(Boolean).join(' | '))
      .join(' || ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url || searchUrl,
      excerpt: excerpt.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err).slice(0, 300));
  }
}
