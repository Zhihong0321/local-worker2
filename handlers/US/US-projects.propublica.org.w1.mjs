export const meta = {
  task: 'US-projects.propublica.org',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ein', 'address', 'city', 'state', 'zipcode', 'ntee_code', 'subsection_code', 'ruling_date', 'tax_period', 'revenue_amount', 'asset_amount', 'profile_url'],
  canary: { found: 'Mozilla Foundation', not_found: 'Xqzvtlkbarf Zyglorp Foundation' },
};

// ProPublica Nonprofit Explorer's public JSON API (documented, no key, no login). The HTML search page sits behind a
// Cloudflare "Security Check" for automated clients, so this handler never reads that page.
const API = 'https://projects.propublica.org/nonprofits/api/v2/';
const SITE = 'https://projects.propublica.org/nonprofits/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  // Node 24 on Windows asserts (exit 127) when a keep-alive socket is still open at process.exit; closing each socket avoids it.
  'Connection': 'close',
};
// Legal-form words dropped from the end of a name before the search and before comparing names.
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'lp', 'llp', 'plc', 'pllc', 'pc']);
const MAX_PAGES = 20;          // 25 organizations per page; 20 pages = 500 results
const START_LIMIT_MS = 30000;  // no new request starts after 30 s, so the whole call stays under 60 s
const MAX_DETAIL = 3;          // organization detail requests for matches (the first 3 only)

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function words(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Normalised name used for comparison: no case, punctuation, legal form or leading "the". */
function core(name) {
  const t = words(name);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  if (t.length > 1 && t[0] === 'the') t.shift();
  return t.join(' ');
}

/** The keyword as sent to the search: the name as typed, minus trailing legal-form words. */
function queryFor(keyword) {
  const parts = String(keyword || '').trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && LEGAL.has(words(parts[parts.length - 1]).join(''))) parts.pop();
  return parts.join(' ');
}

function formatEin(digits) {
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : digits;
}

/** One API call. Returns { status, json, text }; json is null when the body is not JSON. */
async function getApi(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text };
}

/**
 * Turn a search answer into a finished couldnt_check, or return null when the answer is usable.
 * The API answers a search with no hits as HTTP 404 with a JSON body (total_results 0), so a 404 with
 * that body is a normal answer; only a body without the expected JSON is treated as a failure.
 */
function searchFailure(url, r) {
  if (r.status === 403 || r.status === 429) return out('couldnt_check', 'blocked', [], url, `HTTP ${r.status}`);
  if (r.json && Array.isArray(r.json.organizations)) return null;
  if (/captcha|cf-chl|just a moment|security check|access denied|unusual traffic/i.test(r.text)) {
    return out('couldnt_check', 'blocked', [], url, `HTTP ${r.status}, bot or challenge page`);
  }
  if (r.status >= 400) return out('couldnt_check', 'http_error', [], url, `HTTP ${r.status}`);
  return out('couldnt_check', 'layout_changed', [], url, 'search answer is not the expected JSON');
}

function recordFrom(m, detail) {
  const o = detail && detail.organization ? detail.organization : null;
  const ein = m.strein || formatEin(String(m.ein).padStart(9, '0'));
  return {
    name: (o && o.name) || m.name,
    ein,
    address: (o && o.address) || '',
    city: (o && o.city) || m.city || '',
    state: (o && o.state) || m.state || '',
    zipcode: (o && o.zipcode) || '',
    ntee_code: (o && o.ntee_code) || m.ntee_code || '',
    subsection_code: o ? o.subsection_code : (m.subseccd ?? ''),
    ruling_date: (o && o.ruling_date) || '',
    tax_period: (o && o.tax_period) || '',
    revenue_amount: o ? o.revenue_amount : '',
    asset_amount: o ? o.asset_amount : '',
    profile_url: SITE + 'organizations/' + String(m.ein).padStart(9, '0'),
  };
}

async function run(keyword) {
  const started = Date.now();
  const query = queryFor(keyword);
  const target = core(query);
  if (!target) {
    return out('couldnt_check', 'other', [], SITE, 'the company name has no letters or digits');
  }

  const firstUrl = API + 'search.json?' + new URLSearchParams({ q: query });
  const matches = [];
  const seenEin = new Set();
  let pages = 0;
  let seen = 0;
  let total = null;
  let complete = false;
  let stoppedBy = '';
  let page = 0;

  while (true) {
    if (pages >= MAX_PAGES) { stoppedBy = 'page limit'; break; }
    if (pages > 0 && Date.now() - started > START_LIMIT_MS) { stoppedBy = 'time limit'; break; }

    const url = page === 0 ? firstUrl : API + 'search.json?' + new URLSearchParams({ q: query, page: String(page) });
    const r = await getApi(url);
    const fail = searchFailure(url, r);
    if (fail) return fail;
    pages++;
    if (total === null) total = r.json.total_results;

    const orgs = r.json.organizations || [];
    seen += orgs.length;
    for (const o of orgs) {
      if (seenEin.has(o.ein)) continue;
      if (core(o.name) === target || core(o.sub_name || '') === target) {
        seenEin.add(o.ein);
        matches.push(o);
      }
    }

    // num_pages is 0 for an empty result and 1 for a single page of results.
    if (page + 1 >= (r.json.num_pages || 0)) { complete = true; break; }
    page++;
  }

  if (matches.length) {
    const records = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      let detail = null;
      if (i < MAX_DETAIL && Date.now() - started <= START_LIMIT_MS) {
        try {
          const d = await getApi(API + 'organizations/' + String(m.ein).padStart(9, '0') + '.json');
          if (d.status === 200 && d.json && d.json.organization) detail = d.json;
        } catch (_) {
          // detail request failed: keep the search-result fields, the company is still listed
        }
      }
      records.push(recordFrom(m, detail));
    }
    const first = records[0];
    const excerpt = [first.name, [first.city, first.state].filter(Boolean).join(', '), `EIN ${first.ein}`,
      first.ntee_code && `NTEE ${first.ntee_code}`, first.tax_period && `latest tax period ${first.tax_period}`]
      .filter(Boolean).join(' | ');
    return out('found', '', records, first.profile_url, excerpt);
  }

  if (complete) {
    return out('not_found', '', [], firstUrl,
      `No organization named "${query}" among ${seen} search results on ${pages} page(s)` + (total != null ? ` (site total ${total})` : ''));
  }
  return out('couldnt_check', stoppedBy === 'time limit' ? 'timeout' : 'other', [], firstUrl,
    `search "${query}" has ${total} results over more pages; read ${pages} page(s), stopped at the ${stoppedBy}, no exact match yet`);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await run(keyword);
  } catch (err) {
    const text = String(err?.name || '') + ' ' + String(err?.message || err);
    const reason = /abort|timeout/i.test(text) ? 'timeout' : 'other';
    answer = out('couldnt_check', reason, [], API + 'search.json?' + new URLSearchParams({ q: queryFor(keyword) }), text);
  }
  // Give the sockets time to close: on Node 24 / Windows, process.exit() right after a fetch asserts (exit 127).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}
