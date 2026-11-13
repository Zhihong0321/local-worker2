export const meta = {
  task: 'IN-indiaratings.co.in',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'issuer_id', 'ratings'],
  canary: { found: 'Tata Advanced Systems Limited', not_found: 'श्री राम उद्योग प्राइवेट लिमिटेड' },
};

// The site (Angular app) calls these JSON endpoints under its base href "/":
//   home/GetSearch?searchKey=...        -> { issuerList: [{issuerID, name}], pressreleaseList, paidList }
//   home/GetIssuerDetails?issuerId=...  -> [{ name, ratingsList: [{instrumentName, amount, currency, rating}] }]
// The search is a plain "contains" match that returns at most 10 issuers, and it fails when the legal form
// ("Pvt Ltd", "Private Limited") is in the search text. So the legal form is removed from the search text, and
// the names are compared after removing it on both sides.
const BASE = 'https://www.indiaratings.co.in';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': BASE + '/' };
const LEGAL = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'company', 'co', 'the', 'opc', 'inc', 'public']);
const SEARCH_CAP = 10;

function words(s) {
  return String(s || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The name with the legal form and "the" removed, joined with no spaces, for comparing. */
function compareKey(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join('');
}

/** The keyword with the legal-form words removed, for the search box. */
function searchKeyOf(keyword) {
  return String(keyword || '')
    .trim()
    .split(/\s+/)
    .filter((tok) => {
      const w = words(tok);
      return w.length > 0 && !w.every((x) => LEGAL.has(x));
    })
    .join(' ');
}

function cc(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // On Windows, Node asserts (exit 127) when the process exits in the same tick as a finished fetch.
  // A short pause lets the sockets close first; the caller's process.exit then runs cleanly.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function run(keyword) {
  let searchUrl = BASE + '/';
  try {
    const key = searchKeyOf(keyword);
    const want = compareKey(keyword);
    if (!key || want.length === 0) {
      return cc('other', searchUrl, 'the name has no words to search for');
    }

    searchUrl = `${BASE}/home/GetSearch?searchKey=${encodeURIComponent(key)}`;
    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) {
      return cc('blocked', searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return cc('http_error', searchUrl, `HTTP ${res.status}`);
    }

    const body = await res.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      if (/captcha|access denied|are you a robot|challenge-platform|cf-chl/i.test(body.slice(0, 5000))) {
        return cc('blocked', searchUrl, body.slice(0, 200));
      }
      return cc('layout_changed', searchUrl, body.slice(0, 200));
    }
    if (!data || !Array.isArray(data.issuerList)) {
      return cc('layout_changed', searchUrl, JSON.stringify(data).slice(0, 200));
    }

    // Exact match on the name with legal form removed, one entry per issuer ID.
    const matches = new Map();
    for (const it of data.issuerList) {
      if (it && it.issuerID != null && compareKey(it.name) === want) {
        matches.set(String(it.issuerID), String(it.name).trim());
      }
    }

    if (matches.size === 0) {
      if (data.issuerList.length >= SEARCH_CAP) {
        // The site stops at 10 results, so the exact name may be past the cut. Do not say "not found".
        return cc('other', searchUrl, `the search returned ${SEARCH_CAP} results (the site's limit) and none matched exactly`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${data.issuerList.length} result(s) for "${key}", none with this name`,
      };
    }

    // Read the ratings of each matched issuer.
    const details = await Promise.all([...matches.keys()].map(async (id) => {
      const url = `${BASE}/home/GetIssuerDetails?issuerId=${encodeURIComponent(id)}`;
      try {
        const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (!r.ok) return { id, url, error: `HTTP ${r.status}`, reason: r.status === 403 || r.status === 429 ? 'blocked' : 'http_error' };
        const text = await r.text();
        const arr = JSON.parse(text);
        if (!Array.isArray(arr) || !arr[0] || !Array.isArray(arr[0].ratingsList)) {
          return { id, url, error: 'unexpected detail layout', reason: 'layout_changed' };
        }
        return { id, url, item: arr[0] };
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return { id, url, error: String(e && e.message || e).slice(0, 200), reason: timedOut ? 'timeout' : 'other' };
      }
    }));

    const failed = details.find((d) => d.error);
    if (failed) {
      return cc(failed.reason, failed.url, failed.error);
    }

    const records = details.map((d) => ({
      name: matches.get(d.id),
      issuer_id: d.id,
      ratings: (d.item.ratingsList || []).map((r) => ({
        instrument: r.instrumentName ?? null,
        amount: r.amount ?? null,
        currency: r.currency ?? null,
        rating: r.rating ?? null,
      })),
    }));

    const first = records[0];
    const ratingText = first.ratings.map((r) => `${r.instrument}: ${r.rating}`).join('; ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: `${BASE}/search/issuerid/${first.issuer_id}`,
      excerpt: `${first.name} (issuer ${first.issuer_id})${ratingText ? ' | ' + ratingText : ''}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timedOut ? 'timeout' : 'other', searchUrl, String(err && err.message || err));
  }
}
