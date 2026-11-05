export const meta = {
  task: 'MY-ssmsearch.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name or 12-digit SSM registration number (BRN)',
  fields: ['match_count'],
  canary: { found: 'DEZENO', not_found: 'DNE LOGISTICS' },
};

const API = 'https://api.ssmsearch.com/company/search';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Anonymous entity search of the official SSM Search portal (Infomina Berhad).
 * The site's own /search-entity page calls this JSON endpoint from the browser
 * (see the Nuxt bundle: fetch(API_ROOT + '/company/search')). Anonymous callers
 * get back only the number of matching records, no rows: the rows/company profile
 * (name, BRN, status, directors) are released only to logged-in, paying users.
 * So the cheapest readable per-company signal is total >= 1 => a record exists.
 */
export default async function lookup(keyword) {
  const q = String(keyword == null ? '' : keyword).trim().replace(/\s+/g, ' ');
  if (q.length < 3) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: API,
      excerpt: 'The site requires at least 3 characters to search.',
    };
  }

  const body = JSON.stringify({
    search: q,
    type_id: '',
    page: 1,
    offset: 10,
    sort: '',
  });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': UA,
    origin: 'https://ssmsearch.com',
    referer: 'https://ssmsearch.com/search-entity',
  };

  let res = null;
  let text = '';
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(API, {
        method: 'POST',
        headers,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      text = await res.text();
      break;
    } catch (e) {
      res = null;
      lastErr = String((e && e.message) || e);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }

  if (!res) {
    return {
      status: 'couldnt_check',
      reason: /timeout|abort/i.test(lastErr) ? 'timeout' : 'other',
      records: [],
      source_url: API,
      excerpt: ('request failed: ' + lastErr).slice(0, 500),
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'couldnt_check',
      reason: 'blocked',
      records: [],
      source_url: API,
      excerpt: text.slice(0, 500),
    };
  }
  if (res.status !== 200) {
    return {
      status: 'couldnt_check',
      reason: 'http_error',
      records: [],
      source_url: API,
      excerpt: ('HTTP ' + res.status + ' ' + text).slice(0, 500),
    };
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  // Marker check: the anonymous search response always carries a numeric `total`.
  if (!data || typeof data.total !== 'number' || !('is_not_logged_in' in data)) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: API,
      excerpt: text.slice(0, 500),
    };
  }

  const excerpt = text.slice(0, 500);

  if (data.total < 1) {
    return { status: 'not_found', reason: '', records: [], source_url: API, excerpt };
  }

  // Only the match count is readable before payment. Do not claim fields the
  // site did not show us.
  const records = [
    {
      name: q,
      match_count: data.total,
      more_than_limit: data.is_more_than_limit === true,
      note: 'SSM Search returns the number of matching entities to the public; the company record (name, BRN, status) needs a paid/login purchase.',
    },
  ];

  return { status: 'found', reason: '', records, source_url: API, excerpt };
}
