export const meta = {
  task: 'US-sba.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['legal_name', 'dba_name', 'uei', 'cage_code', 'entity_detail_id', 'address', 'city', 'state', 'zipcode',
    'sam_extract_code', 'active_8a', 'active_hubzone', 'active_wosb', 'active_vosb', 'active_sdvosb', 'self_small'],
  canary: { found: 'ACME ENDEAVORS INC.', not_found: 'Zzqxvbnm Holdings LLC' },
};

const SEARCH_URL = 'https://search.certifications.sba.gov/_api/v2/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words ignored when comparing names ("ACME ENDEAVORS INC." == "Acme Endeavors, Inc").
const LEGAL = new Set(['INC', 'INCORPORATED', 'LLC', 'LC', 'LLP', 'LP', 'LTD', 'LIMITED', 'CO', 'COMPANY', 'CORP',
  'CORPORATION', 'PLLC', 'PC', 'PLC']);

function words(name) {
  return String(name || '').toUpperCase().replace(/\./g, '').replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function normalise(name) {
  return words(name).filter((w) => !LEGAL.has(w)).join('');
}

function searchBody(term) {
  return {
    searchProfiles: { searchTerm: term },
    location: { states: [], zipCodes: [], counties: [], districts: [], msas: [] },
    sbaCertifications: { activeCerts: [], isPreviousCert: false, operatorType: 'Or' },
    naics: { codes: [], isPrimary: false, operatorType: 'Or' },
    selfCertifications: { certifications: [], operatorType: 'Or' },
    keywords: { list: [], operatorType: 'Or' },
    lastUpdated: { date: { label: 'Anytime', value: 'anytime' } },
    samStatus: { isActiveSAM: false },
    qualityAssuranceStandards: { qas: [] },
    bondingLevels: { constructionIndividual: '', constructionAggregate: '', serviceIndividual: '', serviceAggregate: '' },
    businessSize: { relationOperator: 'at-least', numberOfEmployees: '' },
    annualRevenue: { relationOperator: 'at-least', annualGrossRevenue: '' },
    entityDetailId: '',
  };
}

function toRecord(r) {
  return {
    legal_name: r.legal_business_name || '',
    dba_name: r.dba_name || '',
    uei: r.uei || '',
    cage_code: r.cage_code || '',
    entity_detail_id: r.entity_detail_id ?? null,
    address: [r.address_1, r.address_2].filter(Boolean).join(' '),
    city: r.city || '',
    state: r.state || '',
    zipcode: r.zipcode || '',
    sam_extract_code: r.sam_extract_code || '',
    active_8a: !!r.active_8a_boolean,
    active_hubzone: !!r.active_hz_boolean,
    active_wosb: !!r.active_wosb_boolean,
    active_vosb: !!r.active_vosb_boolean,
    active_sdvosb: !!r.active_sdvosb_boolean,
    self_small: !!r.self_small_boolean,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const key = normalise(keyword);
  // Search on the name words without the legal form; the match itself is done on normalised names below.
  const term = words(keyword).filter((w) => !LEGAL.has(w)).join(' ') || String(keyword || '').trim();
  try {
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(searchBody(term)),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|access denied|verify you are human/i.test(text)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_URL, excerpt: text.slice(0, 200) };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_URL, excerpt: text.slice(0, 200) };
    }
    if (!data || !Array.isArray(data.results)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_URL, excerpt: text.slice(0, 200) };
    }

    const matches = data.results.filter((r) =>
      normalise(r.legal_business_name) === key || (r.dba_name && normalise(r.dba_name) === key));

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `0 listings named "${String(keyword).trim()}" among ${data.results.length} search results for "${term}"`,
      };
    }

    const first = matches[0];
    return {
      status: 'found',
      reason: '',
      records: matches.map(toRecord),
      source_url: SEARCH_URL,
      excerpt: `${first.legal_business_name} | UEI ${first.uei} | ${first.city}, ${first.state} | ${matches.length} listing(s)`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: SEARCH_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
