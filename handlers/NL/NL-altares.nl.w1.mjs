export const meta = {
  task: 'NL-altares.nl',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'activity', 'address'],
  canary: { found: 'Koninklijke Philips N.V.', not_found: 'Nietbestaande Onderneming Testbedrijf B.V.' },
};

// The company search box on https://www.altares.nl (autocomplete, plugin altares-search-db) calls this public JSON endpoint.
const SEARCH = 'https://www.altares.nl/wp-json/altares-search-db/v1/search';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Referer': 'https://www.altares.nl/',
};

// Dutch legal forms at the end of a name, after punctuation was removed (e.g. "koninklijke philips n v").
const LEGAL_FORM_END = /\s(b ?v|n ?v|v ?o ?f|c ?v|u ?a|besloten vennootschap|naamloze vennootschap|vennootschap onder firma|commanditaire vennootschap|cooperatie u a)$/;

/** "Koninklijke Philips N.V." -> "koninklijkephilips": case, accents, punctuation, spaces and legal form ignored. */
function normalise(name) {
  let s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' en ').replace(/[^a-z0-9]+/g, ' ').trim();
  s = s.replace(LEGAL_FORM_END, '');
  return s.replace(/\s+/g, '');
}

/** The name without a trailing legal form, keeping the user's spelling: "Philips B.V." -> "Philips". */
function withoutLegalForm(name) {
  return String(name || '').trim().replace(/[\s,]+(b\.?\s?v\.?|n\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|c\.?\s?v\.?)$/i, '').trim();
}

const CHALLENGE = /just a moment|challenge-platform|cf-chl|captcha/i;

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** One search request. Returns { items } or { failure } where failure is a couldnt_check answer. */
async function query(term) {
  const url = `${SEARCH}?term=${encodeURIComponent(term)}&lang=NL`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const body = await res.text();
  if (res.status === 403 || res.status === 429) return { failure: fail('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) {
    return { failure: CHALLENGE.test(body) ? fail('blocked', url, `HTTP ${res.status} bot check`) : fail('http_error', url, `HTTP ${res.status}`) };
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { failure: CHALLENGE.test(body) ? fail('blocked', url, 'bot check page') : fail('layout_changed', url, body.slice(0, 200)) };
  }
  if (!Array.isArray(data)) return { failure: fail('layout_changed', url, body.slice(0, 200)) };
  // The site answers an empty search with one placeholder row named "No Results".
  const items = data.filter((it) => it && typeof it.name === 'string' && it.name !== 'No Results');
  if (data.length && !items.length && data.every((it) => it && it.name === 'No Results')) return { items: [], url };
  if (data.length && !items.length) return { failure: fail('layout_changed', url, body.slice(0, 200)) };
  return { items, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows / Node 24 the runner exits right after this returns; if the HTTP socket is still closing then,
  // Node aborts with a libuv assertion and exit code 127. A short pause lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const term = String(keyword || '').trim();
  try {
    if (!term) return fail('other', SEARCH, 'empty company name');
    const key = normalise(term);
    if (!key) return fail('other', SEARCH, 'no usable letters in the company name');

    let r = await query(term);
    if (r.failure) return r.failure;
    let matches = r.items.filter((it) => normalise(it.name) === key);
    let url = r.url;

    // Second try without the legal form, in case the search is strict about "B.V." / "N.V.".
    const bare = withoutLegalForm(term);
    if (!matches.length && bare && bare !== term && normalise(bare)) {
      r = await query(bare);
      if (r.failure) return r.failure;
      matches = r.items.filter((it) => normalise(it.name) === key);
      url = r.url;
    }

    if (!matches.length) {
      const similar = r.items.slice(0, 3).map((it) => it.name).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: similar
          ? `No exact match for "${term}". Similar names on the site: ${similar}`
          : `No results for "${term}"`,
      };
    }

    const records = matches.map((it) => ({
      name: it.name,
      activity: it.activity || '',
      address: it.venue || '',
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: records.map((x) => [x.name, x.activity, x.address].filter(Boolean).join(' | ')).join(' ;; ').slice(0, 300),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', SEARCH, String(err?.message || err));
  }
}
