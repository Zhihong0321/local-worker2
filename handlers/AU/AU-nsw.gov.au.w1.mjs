export const meta = {
  task: 'AU-nsw.gov.au',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['licensee', 'licenceNumber', 'licenceType', 'licenceGroup', 'status', 'address', 'ABN'],
  canary: {
    found: 'Multiplex Constructions Pty Ltd',
    not_found: 'Alexander &CO.'
  }
};

function norm(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(pty|ltd|limited|proprietary)\b/g, '')
    .replace(/\bco\b/g, 'company')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCompany(licensee, keyword) {
  if (!licensee || !keyword) return false;
  const licNorm = norm(licensee);
  const keyNorm = norm(keyword);

  if (licNorm === keyNorm || licNorm.startsWith(keyNorm + ' ')) return true;

  const stopWords = new Set(['the', 'and']);
  const keyWords = keyNorm.split(' ').filter(w => !stopWords.has(w) && w.length > 0);
  if (keyWords.length === 0) return false;

  const licWords = new Set(licNorm.split(' '));
  return keyWords.every(w => licWords.has(w));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const url = 'https://verify.licence.nsw.gov.au/publicregisterapi/api/v1/licence/search/advQuery';
    const cleanKeyword = (keyword || '').trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://verify.licence.nsw.gov.au/',
        excerpt: 'Empty search keyword'
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://verify.licence.nsw.gov.au/',
        'Origin': 'https://verify.licence.nsw.gov.au'
      },
      body: JSON.stringify({
        search: cleanKeyword,
        pageNumber: 0,
        pageSize: 50
      })
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: `http_error: ${res.status}`,
        records: [],
        source_url: url,
        excerpt: `HTTP status ${res.status} returned from search endpoint`
      };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Failed to parse JSON response from search endpoint'
      };
    }

    if (!data || !Array.isArray(data.results)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Expected results array missing from API response'
      };
    }

    const matched = data.results.filter(r => matchCompany(r.licensee, cleanKeyword));

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: `https://verify.licence.nsw.gov.au/home/Trades/results?searchTerm=${encodeURIComponent(cleanKeyword)}`,
        excerpt: `No matching contractor or trade licences found on NSW register for ${cleanKeyword}`
      };
    }

    const records = matched.map(r => ({
      licensee: r.licensee || '',
      licenceNumber: r.licenceNumber || '',
      licenceType: r.licenceType || '',
      licenceGroup: r.licenceGroup || '',
      status: r.status || '',
      address: r.address || '',
      ABN: r.ABN || ''
    }));

    const excerpt = `Found ${matched.length} licence(s) on NSW Public Register: ${records.map(r => `${r.licensee} (${r.licenceType} #${r.licenceNumber}, Status: ${r.status})`).join('; ')}`.slice(0, 500);

    return {
      status: 'found',
      reason: '',
      records,
      source_url: `https://verify.licence.nsw.gov.au/home/Trades/results?searchTerm=${encodeURIComponent(cleanKeyword)}`,
      excerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://verify.licence.nsw.gov.au/',
      excerpt: `Lookup exception: ${err.message}`
    };
  }
}
