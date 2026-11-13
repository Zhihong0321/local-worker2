export const meta = { task: 'GB-ofgem.gov.uk', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'document', 'document_path', 'collection', 'publication', 'matched_on'],
  canary: { found: 'Octopus Energy Limited', not_found: 'Zxqvy Nonexistent Holdings Limited' } };

// Ofgem Electronic Public Register: the public search page (epr.ofgem.gov.uk) calls this GraphQL endpoint anonymously.
const API = 'https://epre-api.ofgem.gov.uk/graphql/';
const SEARCH_PAGE = 'https://epr.ofgem.gov.uk/search?q=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 200;          // results per request
const MAX_RESULTS = 1000;  // most results read per search term
const STOP_AFTER_MS = 30000; // do not start another page after this

const QUERY = `query GetSearchData($term: String, $limit: Int, $offset: Int) {
  search(term: $term, limit: $limit, offset: $offset) {
    count
    items { placement { id name documentPath collection { id label } publication { id name } } }
  }
}`;

const LEGAL = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'lp', 'inc']);

// "&" and "and" count the same; the site's phrase search returns nothing for "&".
function tokens(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' ')
    .split(/[^a-z0-9]+/).filter((w) => w && w !== 'and');
}

function stripLegal(t) {
  const out = t.slice();
  while (out.length && LEGAL.has(out[out.length - 1])) out.pop();
  return out;
}

// Split a document name / path into the parts that can name a company: " - ", " / ", ",", and "-" before a capital.
function segments(text) {
  return (text || '').replace(/\.pdf$/i, '').split(/\s+[-–—]\s+|\s*\/\s*|\s*,\s*|-(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
}

// A segment names the company when, without its legal form, it equals the company or ends with it
// ("Order - ... British Gas Trading Ltd" counts; "Scottish Power Electricity Networks" does not count for "Scottish Power").
function segmentNames(seg, core) {
  const t = stripLegal(tokens(seg));
  if (!core.length || t.length < core.length) return false;
  const tail = t.slice(t.length - core.length);
  return tail.every((w, i) => w === core[i]);
}

function searchUrl(term) {
  return SEARCH_PAGE + encodeURIComponent(term);
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Read up to MAX_RESULTS search hits for one term. Returns { count, items, complete } or { error, excerpt }. */
async function searchAll(term, startedAt) {
  const items = [];
  let count = 0;
  let offset = 0;
  for (;;) {
    if (offset > 0 && Date.now() - startedAt > STOP_AFTER_MS) return { error: 'timeout', excerpt: 'the search did not finish in time' };
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { term, limit: PAGE, offset } }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { error: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { error: 'http_error', excerpt: `HTTP ${res.status}` };
    let body;
    try { body = await res.json(); } catch (e) { return { error: 'layout_changed', excerpt: 'the search answer is not JSON' }; }
    if (body && body.errors && body.errors.length && !(body.data && body.data.search)) {
      return { error: 'other', excerpt: 'GraphQL error: ' + String(body.errors[0].message || '').slice(0, 200) };
    }
    const data = body && body.data && body.data.search;
    if (!data || !Array.isArray(data.items) || typeof data.count !== 'number') {
      return { error: 'layout_changed', excerpt: JSON.stringify(body).slice(0, 300) };
    }
    count = data.count;
    items.push(...data.items);
    offset += data.items.length;
    if (data.items.length === 0 || offset >= count) break;
    if (offset >= MAX_RESULTS) break;
  }
  return { count, items, complete: offset >= count };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // The worker exits right after the answer. On Windows, exiting straight after a fetch whose socket is still
  // open crashes Node (libuv assertion, exit 127). A short pause lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return answer;
}

async function lookupOnce(keyword) {
  const startedAt = Date.now();
  try {
    const kw = String(keyword || '').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!kw) return fail('other', SEARCH_PAGE, 'empty company name');

    // Exact-phrase searches, in order: the name as typed; the name without its legal form; the same two with "&" as "and".
    const words = kw.split(' ');
    while (words.length > 1 && LEGAL.has(tokens(words[words.length - 1]).join(''))) words.pop();
    const core = words.join(' ');
    const coreTokens = tokens(core);
    const phrases = [kw, core, kw.replace(/\s*&\s*/g, ' and '), core.replace(/\s*&\s*/g, ' and ')];
    const terms = [...new Set(phrases.filter((p) => p && tokens(p).length))].map((p) => `"${p}"`);

    let incomplete = false;
    const notes = [];
    for (const term of terms) {
      const r = await searchAll(term, startedAt);
      if (r.error) return fail(r.error, searchUrl(term), r.excerpt);

      const seen = new Set();
      const records = [];
      for (const it of r.items) {
        const p = it && it.placement;
        if (!p || seen.has(p.id)) continue;
        const hit = [['name', p.name], ['document_path', p.documentPath]]
          .map(([where, text]) => ({ where, seg: segments(text).find((s) => segmentNames(s, coreTokens)) }))
          .find((h) => h.seg);
        if (!hit) continue;
        seen.add(p.id);
        records.push({
          name: hit.seg,
          document: (p.name || (p.documentPath || '').split('/').pop() || '').trim(),
          document_path: p.documentPath || '',
          collection: (p.collection && p.collection.label) || '',
          publication: (p.publication && p.publication.name) || '',
          matched_on: hit.where,
        });
      }

      if (records.length) {
        return {
          status: 'found',
          reason: '',
          records,
          source_url: searchUrl(term),
          excerpt: `${records.length} matching document(s) for ${term}; ${records[0].document}`.slice(0, 300),
        };
      }
      notes.push(`${term}: ${r.count} results, none names the company`);
      if (!r.complete) incomplete = true;
    }

    if (incomplete) {
      return fail('other', searchUrl(terms[0]), `more than ${MAX_RESULTS} results and none names the company; ${notes.join('; ')}`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl(terms[0]),
      excerpt: notes.join('; ').slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SEARCH_PAGE, String((err && err.message) || err));
  }
}
