export const meta = {
  task: 'GB-nijobfinder.co.uk',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'recruiter_id', 'employer_url', 'recruiter_type', 'website', 'open_jobs_listed'],
  canary: { found: 'Airbus', not_found: 'Zorvexx Trading Ltd' },
};

const BASE = 'https://www.nijobfinder.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'cic']);

/** Lower-case word tokens; "&" counts as "and". */
function tokens(s) {
  return (s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Words without trailing legal-form words (LTD, LIMITED, PLC...). */
function bodyTokens(s) {
  const t = tokens(s);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

/** Normalised name for comparison: case, punctuation and legal form removed. */
function core(s) {
  return bodyTokens(s).join('');
}

/** The longest word of the name: the site search matches words that start with the typed text. */
function searchTerm(s) {
  return bodyTokens(s).sort((a, b) => b.length - a.length)[0] || '';
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function get(url, accept) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const want = core(keyword);
    const term = searchTerm(keyword);
    if (!want || !term) {
      return fail('other', '', 'no company name is left after removing the legal form');
    }

    // Step 1: the site's own name search (JSON list of {id, name}).
    searchUrl = `${BASE}/recruiter-search?searchQuery=${encodeURIComponent(term)}`;
    // The site's search answers 502 now and then: retry (max 3 tries) while the time budget allows.
    const started = Date.now();
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await get(searchUrl, 'application/json, text/plain, */*');
      if (res.status < 500 || attempt >= 3 || Date.now() - started > 20000) break;
      await new Promise((done) => setTimeout(done, 2000 * attempt));
    }
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const body = await res.text();
    let list = null;
    try { list = JSON.parse(body); } catch { list = null; }
    if (!Array.isArray(list) || list.some((x) => !x || typeof x.id !== 'string' || typeof x.name !== 'string')) {
      if (/captcha|access denied|are you a robot|cloudflare/i.test(body)) return fail('blocked', searchUrl, body.slice(0, 200));
      return fail('layout_changed', searchUrl, body.slice(0, 200));
    }

    // Step 2: keep only exact normalised name matches (not similar words).
    const matches = list.filter((x) => core(x.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${list.length} site entries for "${term}", none with the name "${keyword}"`,
      };
    }

    // Step 3: read each matching employer page for type, website and open jobs.
    const records = await Promise.all(matches.map(async (m) => {
      const url = `${BASE}/employer/${m.id}/`;
      const rec = { name: m.name, recruiter_id: m.id, employer_url: url, recruiter_type: '', website: '', open_jobs_listed: null };
      try {
        const r = await get(url, 'text/html,application/xhtml+xml,*/*;q=0.8');
        if (!r.ok) {
          rec.detail_error = `HTTP ${r.status}`;
          return rec;
        }
        const html = await r.text();
        rec.recruiter_type = (html.match(/"RecruiterType":\s*"([^"]*)"/) || [])[1] || '';
        const site = html.match(/mds-list__key">Website<\/dt>\s*<dd[^>]*>\s*<a[^>]*href="([^"]+)"/);
        rec.website = site ? site[1].replace(/&amp;/g, '&') : '';
        rec.open_jobs_listed = new Set([...html.matchAll(/href="\/job\/(\d+)\//g)].map((x) => x[1])).size;
      } catch (e) {
        rec.detail_error = String(e?.name || e?.message || e).slice(0, 100);
      }
      return rec;
    }));

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.employer_url,
      excerpt: `${first.name} | ${first.recruiter_type || 'type not shown'} | website ${first.website || 'not shown'} | ${first.open_jobs_listed ?? 0} job links on the employer page`,
    };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, searchUrl, String(err?.message || err));
  }
}
