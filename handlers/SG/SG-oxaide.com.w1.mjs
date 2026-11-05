export const meta = {
  task: 'SG-oxaide.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'uen', 'status', 'live'],
  canary: { found: 'OOm Pte Ltd', not_found: 'Makoto-Ya Singapore' },
};

function matchWords(keyword, candName) {
  const normKw = keyword.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const normCand = candName.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  
  if (normCand === normKw) return true;
  
  const kwWords = normKw.split(/\s+/).filter(w => !['PTE', 'LTD', 'LIMITED', 'PRIVATE', 'LLP', 'SINGAPORE'].includes(w));
  const candWords = normCand.split(/\s+/).filter(w => !['PTE', 'LTD', 'LIMITED', 'PRIVATE', 'LLP'].includes(w));
  
  if (kwWords.length === 0) return false;
  return kwWords.every(w => candWords.includes(w));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://oxaide.com/tools/uen-check',
      excerpt: 'Empty keyword provided'
    };
  }

  const cleanKeyword = keyword.trim();
  const searchUrl = `https://oxaide.com/api/entity-search?name=${encodeURIComponent(cleanKeyword)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (res.status === 403 || res.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP ${res.status}`
      };
    }

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP ${res.status} ${res.statusText}`
      };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data.ok !== 'boolean') {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Response JSON missing expected ok property'
      };
    }

    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    if (candidates.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `No matching entities found for ${cleanKeyword}`
      };
    }

    const matched = candidates.filter(c => c && c.name && matchWords(cleanKeyword, c.name));

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Candidates returned (${candidates.map(c => c.name).join(', ')}) do not match ${cleanKeyword}`
      };
    }

    const records = matched.map(c => ({
      name: c.name || '',
      uen: c.uen || '',
      status: c.status || '',
      live: !!c.live
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: JSON.stringify(records[0])
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'AbortError' ? 'timeout' : 'http_error',
      records: [],
      source_url: searchUrl,
      excerpt: err.message || String(err)
    };
  }
}
