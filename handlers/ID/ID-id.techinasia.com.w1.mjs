export const meta = { task: 'ID-id.techinasia.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'entity_slug', 'entity_id', 'country', 'date_founded', 'status', 'employee_count', 'description'],
  canary: { found: 'Tokopedia', not_found: 'Warung Rambutan Biru Sentosa Lestari' } };

// The company database on id.techinasia.com (its "Database" section) searches an Algolia index. The site sends the
// search-only application id and key below to every visitor's browser (app.2b59151a.js). Public search key, not a
// user credential; read only.
const ALGOLIA_APP_ID = '219WX3MPV4';
const ALGOLIA_SEARCH_KEY = 'b528008a75dc1c4402bfe0d8db8b3f8e';
const INDEX = 'companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words (Indonesian and common foreign forms). Stripped from the start and end of a name before comparing.
// Searching with "PT" in the query returns nothing on this index, so they are also removed from the query.
const LEGAL = new Set(['pt', 'tbk', 'persero', 'perseroan', 'terbatas', 'cv', 'ud', 'pte', 'ltd', 'limited', 'inc', 'corp',
  'co', 'llc', 'plc', 'sdn', 'bhd', 'pty', 'gmbh']);

function words(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

function coreWords(s) {
  const w = words(s);
  while (w.length && LEGAL.has(w[0])) w.shift();
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

function couldnt(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await check(keyword);
  // Windows Node (v24) aborts at process exit if the Algolia keep-alive socket is still closing when the runner calls
  // process.exit(), which turns a finished answer into exit code 127. A short pause lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function check(keyword) {
  const source_url = `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${INDEX}/query`;
  try {
    const core = coreWords(keyword);
    const queryText = (core.length ? core : words(keyword)).join(' ');
    const want = core.join('');
    if (!queryText) return couldnt('other', 'empty company name', source_url);

    const res = await fetch(source_url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        'X-Algolia-API-Key': ALGOLIA_SEARCH_KEY,
      },
      body: JSON.stringify({ params: `query=${encodeURIComponent(queryText)}&hitsPerPage=20` }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, source_url);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, source_url);

    let data;
    try { data = await res.json(); } catch { return couldnt('layout_changed', 'search answer is not JSON', source_url); }
    if (!data || !Array.isArray(data.hits)) return couldnt('layout_changed', 'search answer has no hits list', source_url);

    // Match the company, not similar words: same name once case, punctuation and legal form are ignored.
    const matches = data.hits.filter((h) => want && coreWords(h.name || '').join('') === want);

    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: `Tech in Asia Indonesia company database: ${data.nbHits ?? data.hits.length} result(s) for "${queryText}", none with this name`,
      };
    }

    const records = matches.map((h) => ({
      name: h.name || '',
      entity_slug: h.entity_slug || '',
      entity_id: h.entity_id || '',
      country: (h.entity_locations || []).map((l) => l.country_name).filter(Boolean).join(', '),
      date_founded: h.date_founded || '',
      status: h.status || '',
      employee_count: h.employee_count || '',
      description: String(h.description || '').slice(0, 300),
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url,
      excerpt: `Tech in Asia Indonesia company database: ${matches.length} exact match(es) for "${keyword}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err).slice(0, 300), source_url);
  }
}
