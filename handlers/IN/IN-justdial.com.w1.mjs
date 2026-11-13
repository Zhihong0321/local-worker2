export const meta = {
  task: 'IN-justdial.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'docid', 'address', 'area', 'city', 'category', 'rating', 'reviews', 'verified', 'profile_url'],
  canary: { found: 'Reliance Digital', not_found: 'Zqxwv Nonexistent Company Qq' },
};

// Justdial search is per city (no national search route). These are the largest metros; not_found means
// "not on the first results page of these cities", never "not in India".
const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad'];
const BUDGET_MS = 45000; // stay well under the 60 s limit
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation', 'opc', 'plc']);

/** Normalise a company name: lower case, bracketed parts dropped, legal-form words dropped, punctuation dropped. */
function norm(s) {
  const t = String(s ?? '').normalize('NFC').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ');
  return t.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !LEGAL.has(w)).join('');
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt ?? '').slice(0, 500) };
}

/** Search one city. Returns { url, matches, total } or { url, problem: { reason, excerpt } }. Never throws. */
async function searchCity(city, kw, kwNorm, timeoutMs) {
  const url = `https://www.justdial.com/${city}/search?q=${encodeURIComponent(kw)}&stype=company_list`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(Math.max(1000, Math.min(25000, timeoutMs))),
    });
    if (res.status === 403 || res.status === 429) return { url, problem: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
    if (!res.ok) return { url, problem: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };

    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      // An (almost) empty 200 is how the edge answers a bot check; a real page without the data block is a layout change.
      const reason = html.length < 200 || /captcha|are you a robot|access denied/i.test(html) ? 'blocked' : 'layout_changed';
      return { url, problem: { reason, excerpt: `no results data (${html.replace(/\s+/g, ' ').slice(0, 200)})` } };
    }

    let pp;
    try { pp = JSON.parse(m[1]).props.pageProps; } catch { return { url, problem: { reason: 'layout_changed', excerpt: 'results data is not JSON' } }; }
    const ld = pp?.listData;
    const res2 = ld?.results;
    if (!res2 || !Array.isArray(res2.columns) || !Array.isArray(res2.data) || !res2.columns.includes('name')) {
      return { url, problem: { reason: 'layout_changed', excerpt: 'results table not found' } };
    }

    // The site must have searched what we sent; Devanagari queries come back as an empty search.
    const echoed = pp?.query?.q ?? ld?.keyword ?? '';
    if (norm(echoed) !== kwNorm) {
      return { url, problem: { reason: 'other', excerpt: `site did not take the query (it searched "${String(echoed).slice(0, 80)}")` } };
    }

    const cols = res2.columns;
    const get = (row, name) => {
      const i = cols.indexOf(name);
      const v = i >= 0 ? row[i] : '';
      return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    };
    const matches = res2.data
      .filter((row) => Array.isArray(row))
      .filter((row) => norm(get(row, 'name')) === kwNorm)
      .map((row) => {
        const weburl = get(row, 'weburl');
        return {
          name: get(row, 'name'),
          docid: get(row, 'docid'),
          address: get(row, 'NewAddress'),
          area: get(row, 'area'),
          city: get(row, 'city') || city,
          category: get(row, 'type'),
          rating: get(row, 'compRating'),
          reviews: get(row, 'totalReviews'),
          verified: get(row, 'verified'),
          profile_url: get(row, 'sharedt_url') || (weburl ? `https://www.justdial.com/${weburl}` : ''),
        };
      });
    return { url, matches, total: ld?.totalNumberofResults ?? null };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, problem: { reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err) } };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword ?? '').trim();
    const kwNorm = norm(kw);
    if (!kwNorm) return out('couldnt_check', 'other', [], '', 'empty company name');

    const searched = [];
    let problem = null;
    let lastUrl = '';
    for (const city of CITIES) {
      const left = BUDGET_MS - (Date.now() - started);
      if (left <= 1000) {
        problem = { reason: 'timeout', source_url: lastUrl, excerpt: 'time budget used before every city was searched' };
        break;
      }
      const r = await searchCity(city, kw, kwNorm, left);
      lastUrl = r.url;
      if (r.problem) {
        problem = { reason: r.problem.reason, source_url: r.url, excerpt: `${city}: ${r.problem.excerpt}` };
        break; // one refusal means the answer is unknown, so stop
      }
      searched.push(city);
      if (r.matches.length) {
        return out('found', '', r.matches, r.url,
          `${r.matches.length} exact name match(es) in ${city} (site total for this search: ${r.total})`);
      }
    }

    if (problem) return out('couldnt_check', problem.reason, [], problem.source_url, problem.excerpt);
    return out('not_found', '', [], lastUrl,
      `No exact name match on the first results page of: ${searched.join(', ')}. Other cities were not searched.`);
  } catch (err) {
    return out('couldnt_check', 'other', [], '', String(err?.message || err));
  }
}
