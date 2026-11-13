export const meta = {
  task: 'SG-jobstreet.com.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'slug', 'profile_url', 'organisation_id', 'zone', 'review_count', 'review_rating', 'published'],
  canary: { found: 'DBS Bank', not_found: '诺达虚构贸易有限公司' },
};

// The site's own company search page calls this GraphQL endpoint (operation SearchCompanies) with zone asia-7 for Singapore.
const ENDPOINT = 'https://sg.jobstreet.com/graphql';
const ZONE = 'asia-7';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUERY = 'query SearchCompanies($name: String!, $includeBranding: Boolean!, $limit: Int, $zone: Zone, $published: Boolean) { searchCompanyProfilesByName(name: $name, includeBranding: $includeBranding, limit: $limit, zone: $zone, published: $published) { companyId data { name reviewCount reviewRating slug published } organisationId zone } }';

// Legal-form words that only count at the end of a name ("DBS Bank Pte Ltd" = "DBS Bank").
const LEGAL_FORMS = new Set(['pte', 'ltd', 'limited', 'llp', 'llc', 'inc', 'corp', 'co', 'company', 'pvt', 'private', 'plc', 'sdn', 'bhd']);

/** Lower-case, drop punctuation and spaces, drop trailing legal-form words. */
function normalise(name) {
  const words = (name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pageUrl = `https://sg.jobstreet.com/companies/search?keywords=${encodeURIComponent(keyword || '')}`;
  try {
    const target = normalise(keyword);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: 'empty company name' };
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://sg.jobstreet.com',
        'Referer': pageUrl,
      },
      body: JSON.stringify({
        operationName: 'SearchCompanies',
        query: QUERY,
        variables: { name: keyword, includeBranding: false, limit: 20, zone: ZONE, published: true },
      }),
      signal: AbortSignal.timeout(25000),
    });

    const text = await res.text();
    if (res.status === 403 || res.status === 429 || /just a moment|challenge-platform|captcha/i.test(text.slice(0, 4000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: text.slice(0, 300) };
    }
    if (Array.isArray(body?.errors) && body.errors.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: String(body.errors[0]?.message || 'GraphQL error').slice(0, 300) };
    }

    const list = body?.data?.searchCompanyProfilesByName;
    if (!Array.isArray(list)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: text.slice(0, 300) };
    }

    const matches = list.filter((c) => c && c.data && normalise(c.data.name) === target);
    if (!matches.length) {
      const names = list.map((c) => c?.data?.name).filter(Boolean).slice(0, 5).join(', ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: list.length ? `${list.length} other result(s), none with this name: ${names}` : '0 results',
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((c) => ({
        name: c.data.name,
        company_id: c.companyId,
        slug: c.data.slug,
        profile_url: `https://sg.jobstreet.com/companies/${c.data.slug}`,
        organisation_id: c.organisationId,
        zone: c.zone,
        review_count: c.data.reviewCount,
        review_rating: c.data.reviewRating,
        published: c.data.published,
      })),
      source_url: pageUrl,
      excerpt: matches.map((c) => `${c.data.name} (${c.companyId})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: pageUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
