export const meta = {
  task: 'CH-finma.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'listed_date', 'commercial_register', 'detail_url'],
  canary: { found: 'Firstcrest bank', not_found: 'Zürcher Gartenbau Musterhaus Genossenschaft' },
};

// FINMA warning list (public page). Its search box posts to the filter API below with the list's own source id.
const LIST_URL = 'https://www.finma.ch/en/finma-public/warnungen/warning-list/';
const SEARCH_URL = 'https://www.finma.ch/en/api/search/getresult';
const SOURCE_ID = '{1C6B8731-638C-4003-A93C-A625BF7A6800}';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words. The search returns nothing when they are left in the query ("Firstcrest bank AG" -> 0 items),
// so they are removed from the query and from both sides of the name comparison.
const LEGAL_FORMS = new Set(['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'kg', 'ltd', 'llc', 'inc', 'corp', 'co', 'plc',
  'genossenschaft', 'stiftung', 'bv', 'nv', 'ab', 'oy', 'srl', 'spa']);

function words(str) {
  return String(str || '')
    .replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function coreWords(str) {
  return words(str).filter((w) => !LEGAL_FORMS.has(w));
}

function normKey(str) {
  return coreWords(str).join('');
}

// Node 24 on Windows can abort the worker's process.exit() while a POST socket is still closing (libuv assertion,
// exit 127). A short wait after the answer is ready lets the socket finish closing before the process exits.
const SETTLE_MS = 300;

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await runLookup(keyword);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return result;
}

async function runLookup(keyword) {
  try {
    const name = typeof keyword === 'string' ? keyword.trim() : '';
    const query = coreWords(name).join(' ');
    if (!query) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
        excerpt: 'no searchable words left after removing the legal form' };
    }
    const keyNorm = normKey(name);

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': LIST_URL,
        'Origin': 'https://www.finma.ch',
      },
      body: new URLSearchParams({ ds: SOURCE_ID, query }).toString(),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: text.slice(0, 300) };
    }
    if (!data || !Array.isArray(data.Items)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: text.slice(0, 300) };
    }

    const items = data.Items.filter((i) => i && typeof i.Title === 'string');
    const matches = items.filter((i) => {
      const segments = i.Title.split(/[\/;]/).map(normKey);
      return keyNorm !== '' && (segments.includes(keyNorm) || normKey(i.Title) === keyNorm);
    });

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `0 warning-list entries match "${name}" (${items.length} other entries returned for "${query}")` };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((i) => ({
        name: i.Title,
        listed_date: i.Date || '',
        commercial_register: i.FacetColumn || '',
        detail_url: new URL(i.Link, 'https://www.finma.ch').href,
      })),
      source_url: LIST_URL,
      excerpt: matches.map((i) => `${i.Title} (${i.Date || 'no date'}) - ${i.FacetColumn || 'no register status'}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
