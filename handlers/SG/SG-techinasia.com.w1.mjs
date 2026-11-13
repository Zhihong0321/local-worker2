export const meta = {
  task: 'SG-techinasia.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entity_slug', 'entity_id', 'date_founded', 'employee_count', 'website', 'hq_location', 'description', 'industries', 'last_funding_stage', 'total_amount_raised', 'status_labels'],
  canary: { found: 'Carousell', not_found: '新加坡不存在科技私人有限公司' },
};

// The Tech in Asia company directory (techinasia.com/companies) is a client-side page. Its search box calls the
// Algolia index below with the search-only key that the public site ships to every visitor's browser.
const ALGOLIA_APP = '219WX3MPV4';
const ALGOLIA_KEY = 'b528008a75dc1c4402bfe0d8db8b3f8e';
const ALGOLIA_INDEX = 'companies_sort_total_amount_raised_2y_desc';
const ALGOLIA_URL = `https://${ALGOLIA_APP}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;
const DIRECTORY_URL = 'https://www.techinasia.com/companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that do not change which company is meant (Pte Ltd, Sdn Bhd, Inc, ...).
const LEGAL_FORMS = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'sdn', 'bhd', 'berhad', 'inc', 'incorporated',
  'llc', 'llp', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh']);

function tokens(str) {
  // Lower case, drop accents and punctuation; letters and digits in any script are kept (CJK names stay intact).
  const plain = (str || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  return plain.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Name as compared: lower case, no punctuation, no legal form. Falls back to all words if only legal form words exist. */
function normalizeName(str) {
  const all = tokens(str);
  const core = all.filter((t) => !LEGAL_FORMS.has(t));
  return (core.length ? core : all).join('');
}

function cleanText(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function describeHq(locations) {
  const hq = (locations || []).find((l) => l && l.type === 'hq') || (locations || [])[0];
  if (!hq) return '';
  return [hq.city_name, hq.country_name].filter(Boolean).join(', ');
}

function toRecord(hit) {
  const website = (hit.entity_sites || []).find((s) => s && s.site_name === 'Website');
  return {
    name: hit.name || '',
    entity_slug: hit.entity_slug || '',
    entity_id: hit.entity_id || hit.objectID || '',
    date_founded: hit.date_founded || '',
    employee_count: hit.employee_count || '',
    website: website ? website.url : '',
    hq_location: describeHq(hit.entity_locations),
    description: cleanText(hit.pitch || hit.description || ''),
    industries: (hit.entity_industries || []).map((i) => i.name).filter(Boolean),
    last_funding_stage: hit.last_funding_stage || '',
    total_amount_raised: hit.total_amount_raised ?? '',
    status_labels: (hit.status || []).map((s) => s.label).filter(Boolean),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  try {
    const wanted = normalizeName(name);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'empty company name' };
    }

    // Search with the name minus legal-form words, so "Acme Pte Ltd" also finds "Acme".
    const queryText = tokens(name).filter((t) => !LEGAL_FORMS.has(t)).join(' ') || name;
    const params = new URLSearchParams({ query: queryText, hitsPerPage: '50' }).toString();

    const res = await fetch(ALGOLIA_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': ALGOLIA_APP,
        'X-Algolia-API-Key': ALGOLIA_KEY,
      },
      body: JSON.stringify({ params }),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: 'response is not JSON' };
    }
    if (!data || !Array.isArray(data.hits)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: JSON.stringify(data).slice(0, 300) };
    }

    const matches = data.hits.filter((hit) => normalizeName(hit.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: DIRECTORY_URL,
        excerpt: `0 companies named "${name}" in the directory (${data.hits.length} search hits checked)`,
      };
    }

    const records = matches.map(toRecord);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: `https://www.techinasia.com/companies/${matches[0].entity_slug || ''}`.replace(/\/$/, ''),
      excerpt: `${matches.length} match(es) for "${name}": ${records.map((r) => r.name).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: DIRECTORY_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
