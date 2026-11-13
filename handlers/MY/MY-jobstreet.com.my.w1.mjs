export const meta = {
  task: 'MY-jobstreet.com.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'organisation_id', 'zone', 'published', 'slug', 'profile_url'],
  canary: { found: 'Averis Sdn Bhd', not_found: 'Syarikat Fiktif Sdn Bhd' },
};

const SITE = 'https://my.jobstreet.com';
const ZONE = 'asia-5'; // Malaysia zone used by the public company search page (without it the site returns nothing)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUERY = `query SearchCompanies($name: String!, $includeBranding: Boolean!, $limit: Int, $zone: Zone, $published: Boolean) {
  searchCompanyProfilesByName(name: $name, includeBranding: $includeBranding, limit: $limit, zone: $zone, published: $published) {
    companyId
    data { name slug published }
    organisationId
    zone
  }
}`;

// Legal-form words and the "(M)" marker are removed before comparing, so "ACME TRADING SDN BHD" matches "Acme Trading Sdn Bhd".
const LEGAL_WORDS = new Set(['sdn', 'bhd', 'berhad', 'plt', 'llp']);

function core(str) {
  const tokens = (str || '')
    .toLowerCase()
    .replace(/\((m|malaysia)\)/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL_WORDS.has(t));
  return tokens.join('');
}

function searchPageUrl(keyword) {
  return `${SITE}/companies/search?term=${encodeURIComponent(keyword)}`;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // On Windows (Node 24) the runner calls process.exit() right after this returns, and that aborts with a libuv
  // assertion (exit 127) while the HTTPS socket to this site is still closing. A short pause lets it settle.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  const pageUrl = searchPageUrl(keyword);
  try {
    const name = String(keyword || '').trim();
    if (!core(name)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: 'no company name to search for' };
    }
    // The site's search matches the name without the legal form ("Averis berhad" finds nothing, "Averis" finds Averis Sdn Bhd).
    const searchName = name
      .replace(/\((m|malaysia)\)/gi, ' ')
      .split(/\s+/)
      .filter((t) => t && !LEGAL_WORDS.has(t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')))
      .join(' ');

    const res = await fetch(`${SITE}/graphql`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': SITE,
        'Referer': pageUrl,
      },
      body: JSON.stringify({
        operationName: 'SearchCompanies',
        variables: { name: searchName, includeBranding: false, limit: 50, zone: ZONE },
        query: QUERY,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: text.replace(/\s+/g, ' ').slice(0, 300) };
    }

    if (Array.isArray(json?.errors) && json.errors.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: String(json.errors[0]?.message || 'GraphQL error').slice(0, 300) };
    }
    const hits = json?.data?.searchCompanyProfilesByName;
    if (!Array.isArray(hits)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: text.slice(0, 300) };
    }

    const wanted = core(name);
    const matches = hits.filter((h) => core(h?.data?.name) === wanted);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: `Found 0 matching company profiles for "${name}" in zone ${ZONE} (${hits.length} search results, none with the same name)`,
      };
    }

    const records = matches.map((h) => ({
      name: h.data.name,
      company_id: String(h.companyId),
      organisation_id: String(h.organisationId ?? ''),
      zone: h.zone ?? ZONE,
      published: h.data.published === true,
      slug: h.data.slug,
      profile_url: `${SITE}/companies/${h.data.slug}`,
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt: `Found ${records.length} matching company profile(s): ${records.map((r) => r.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: pageUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
