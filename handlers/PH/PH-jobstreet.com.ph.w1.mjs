export const meta = {
  task: 'PH-jobstreet.com.ph',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'organisation_id', 'zone', 'profile_url', 'review_count', 'review_rating'],
  canary: { found: 'Jollibee Foods Corporation', not_found: 'Kumpanyang Hindi Nakalista sa Pilipinas Inc.' },
};

// JobStreet's company search box (ph.jobstreet.com/companies, "Search by company name") sends this public,
// anonymous GraphQL request. No login, no token, no cookie is needed.
const SITE = 'https://ph.jobstreet.com';
const GRAPHQL = `${SITE}/graphql`;
const ZONE = 'asia-6'; // the Philippines zone the site itself uses; without it the search returns nothing
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUERY = `query SearchCompanies($name: String!, $includeBranding: Boolean!, $limit: Int, $zone: Zone, $published: Boolean) {
  searchCompanyProfilesByName(name: $name, includeBranding: $includeBranding, limit: $limit, zone: $zone, published: $published) {
    companyId
    data { name slug published reviewCount reviewRating }
    organisationId
    zone
  }
}`;

// Legal-form words that sit at the end of a name. The site's search fails when they are sent ("... Corporation Inc"
// returns nothing), so they are removed both from the search text and from the comparison.
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'lp', 'llp',
  'opc', 'plc', 'pte', 'sdn', 'bhd', 'pty', 'gmbh', 'sa', 'ag']);

/** Lower-case, Unicode-aware (keeps local-script letters), punctuation turned into spaces. */
function words(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** The comparable core of a company name: no leading "the", no trailing legal form. */
function core(s) {
  const w = words(s);
  if (w.length > 1 && w[0] === 'the') w.shift();
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows aborts (exit 127, after the answer is printed) when the harness calls process.exit()
  // straight after a POST/GET to this site, while the keep-alive socket is still closing. A short pause lets it close.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const core_words = core(keyword);
    if (!core_words.length) return couldnt('other', GRAPHQL, 'empty company name');
    const searchName = core_words.join(' ');
    const wantKey = core_words.join('');

    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': SITE,
        'Referer': `${SITE}/companies`,
      },
      body: JSON.stringify({
        operationName: 'SearchCompanies',
        query: QUERY,
        variables: { name: searchName, includeBranding: false, limit: 50, zone: ZONE, published: true },
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return couldnt('blocked', GRAPHQL, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', GRAPHQL, `HTTP ${res.status}`);

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      const challenge = /captcha|challenge|cf-chl|Just a moment|Attention Required|access denied/i.test(text.slice(0, 5000));
      return couldnt(challenge ? 'blocked' : 'layout_changed', GRAPHQL, text.slice(0, 300));
    }

    if (Array.isArray(body?.errors) && body.errors.length) {
      return couldnt('other', GRAPHQL, JSON.stringify(body.errors).slice(0, 300));
    }
    const list = body?.data?.searchCompanyProfilesByName;
    if (!Array.isArray(list)) return couldnt('layout_changed', GRAPHQL, text.slice(0, 300));

    const matches = list.filter((r) => core(r?.data?.name).join('') === wantKey);
    if (!matches.length) {
      const seen = list.slice(0, 5).map((r) => r?.data?.name).filter(Boolean).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: GRAPHQL,
        excerpt: `Site search for "${searchName}" returned ${list.length} result(s) and none has this name${seen ? ` (first: ${seen})` : ''}`,
      };
    }

    const records = matches.map((r) => ({
      name: r.data.name,
      company_id: r.companyId,
      organisation_id: r.organisationId,
      zone: r.zone,
      profile_url: `${SITE}/companies/${r.data.slug}`,
      review_count: r.data.reviewCount ?? null,
      review_rating: r.data.reviewRating ?? null,
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url,
      excerpt: `${records.length} matching profile(s) on the site search for "${searchName}"`,
    };
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return couldnt('timeout', GRAPHQL, 'no answer within 25 s');
    return couldnt('other', GRAPHQL, String(err?.message || err));
  }
}
