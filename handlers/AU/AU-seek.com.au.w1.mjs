export const meta = {
  task: 'AU-seek.com.au',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'organisation_id', 'zone', 'published', 'profile_url', 'review_count', 'review_rating'],
  canary: { found: 'CommBank', not_found: 'Zqxvbrl Plorkentia Holdings' },
};

const SITE = 'https://au.seek.com';
const GRAPHQL_URL = `${SITE}/graphql`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The same query the company pages send to the public GraphQL endpoint (anonymous, no token).
const QUERY = `
  query SearchCompanies($name: String!, $includeBranding: Boolean!, $limit: Int, $zone: Zone, $published: Boolean) {
    searchCompanyProfilesByName(name: $name, includeBranding: $includeBranding, limit: $limit, zone: $zone, published: $published) {
      companyId
      data { name slug published reviewCount reviewRating }
      organisationId
      zone
    }
  }`;

// Legal-form words dropped from the end of a name before two names are compared.
const LEGAL_FORMS = new Set(['pty', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'plc', 'co', 'corp', 'corporation',
  'company', 'sdn', 'bhd', 'pte', 'gmbh', 'ag', 'sa', 'nv', 'bv', 'llp', 'lp']);

function words(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean);
}

function coreWords(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL_FORMS.has(w[w.length - 1])) w.pop();
  return w;
}

// Comparison key: case, punctuation, spacing and legal form ignored. Non-Latin names fall back to their own characters.
function nameKey(s) {
  return coreWords(s).join('') || String(s || '').toLowerCase().replace(/\s+/g, '');
}

function result(status, reason, sourceUrl, excerpt, records = []) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows aborts (libuv assertion, exit 127) when the runner calls process.exit() while a socket from
  // fetch is still closing. A short pause lets the socket close first. It costs 0.3 s and never fails the answer.
  await new Promise((done) => setTimeout(done, 300));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const raw = typeof keyword === 'string' ? keyword.trim() : '';
    if (!raw) return result('couldnt_check', 'other', `${SITE}/companies`, 'empty company name');

    const term = (coreWords(raw).join(' ') || raw).slice(0, 200);
    const key = nameKey(raw);
    const searchUrl = `${SITE}/companies/search?q=${encodeURIComponent(term)}`;

    const body = {
      operationName: 'SearchCompanies',
      query: QUERY,
      variables: { name: term, includeBranding: false, limit: 50, zone: 'anz-1', published: true },
    };
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/graphql-response+json, application/json',
        'X-Seek-Site': 'candidate-seek-au',
        'Origin': SITE,
        'Referer': searchUrl,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return result('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!res.ok) {
      return result('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);
    }

    const botWall = /captcha|verify you are human|access denied|challenge/i;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return result('couldnt_check', botWall.test(text) ? 'blocked' : 'layout_changed', searchUrl, text.slice(0, 300));
    }

    const list = json?.data?.searchCompanyProfilesByName;
    if (!Array.isArray(list)) {
      if (Array.isArray(json?.errors) && json.errors.length) {
        return result('couldnt_check', 'other', searchUrl, `GraphQL error: ${json.errors[0]?.message || ''}`);
      }
      return result('couldnt_check', 'layout_changed', searchUrl, text.slice(0, 300));
    }

    const matches = list.filter((c) => c && c.data && nameKey(c.data.name) === key);
    if (matches.length === 0) {
      const names = list.slice(0, 5).map((c) => c?.data?.name).filter(Boolean).join(', ');
      return result('not_found', '', searchUrl,
        `Seek search "${term}" returned ${list.length} result(s), none with the name "${raw}"${names ? `; first results: ${names}` : ''}`);
    }

    const records = matches.map((c) => ({
      name: c.data.name,
      company_id: c.companyId,
      organisation_id: c.organisationId ?? null,
      zone: c.zone ?? null,
      published: c.data.published ?? null,
      profile_url: c.data.slug ? `${SITE}/companies/${c.data.slug}` : '',
      review_count: c.data.reviewCount ?? null,
      review_rating: c.data.reviewRating ?? null,
    }));
    const first = records[0];
    return result('found', '', first.profile_url || searchUrl,
      `Seek company profile: ${first.name}; reviews ${first.review_count ?? 'n/a'}, rating ${first.review_rating ?? 'n/a'}`,
      records);
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return result('couldnt_check', timeout ? 'timeout' : 'other',
      `${SITE}/companies/search`, String(err?.message || err));
  }
}
