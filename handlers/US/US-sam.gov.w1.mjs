export const meta = {
  task: 'US-sam.gov',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'uei', 'cage_code', 'dodaac'],
  canary: { found: 'BOOZ ALLEN HAMILTON INC', not_found: 'ZQXWV NOSUCH HOLDINGS LLC' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://sam.gov/api/prod/entity-information/v1/api/entity-picker-data';
const SIZE = 50;
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'lp', 'llp', 'pllc', 'pc', 'gmbh', 'sa']);

/** Lower-case words, legal form removed from the end: "ACME, Inc." -> "acme". */
function coreKey(s) {
  const w = (s || '').toLowerCase().replace(/\./g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** Text sent to the site: the name as typed, punctuation removed, trailing legal form removed. */
function searchText(s, keepLegal) {
  const w = (s || '').replace(/\./g, '').replace(/[,;:()"]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (!keepLegal && w.length > 1 && LEGAL.has(w[w.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) w.pop();
  return w.join(' ');
}

async function suggest(text) {
  const url = `${BASE}?size=${SIZE}&fieldName=legalBusinessNameSuggest&text=${encodeURIComponent(text)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/hal+json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url, excerpt: String(err?.message || err).slice(0, 200) } };
  }
  if (res.status === 403 || res.status === 429) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` } };
  }
  const body = await res.text();
  let list;
  try {
    list = JSON.parse(body);
  } catch {
    const reason = /captcha|challenge|access denied/i.test(body) ? 'blocked' : 'layout_changed';
    return { fail: { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: body.slice(0, 200) } };
  }
  if (!Array.isArray(list) || list.some((e) => !e || typeof e !== 'object')) {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: body.slice(0, 200) } };
  }
  return { url, list };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node on Windows aborts (exit 127) if the process exits while a keep-alive socket is still closing;
  // the harness exits right after the answer, so give the sockets a moment to close first.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const want = coreKey(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    const passes = [searchText(keyword, false)];
    let sourceUrl = '';
    let capped = false;
    let names = [];

    for (let i = 0; i < 2; i++) {
      if (i === 1) {
        // The first list was full, so the company may sit past the cut-off: retry with the legal form included.
        const full = searchText(keyword, true);
        if (full === passes[0]) break;
        passes.push(full);
      }
      const r = await suggest(passes[i]);
      if (r.fail) return r.fail;
      sourceUrl = r.url;

      const matches = r.list.filter((e) => e && coreKey(e.legalBusinessName) === want);
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches.map((e) => ({
            name: e.legalBusinessName,
            uei: e.ueiSAM || null,
            cage_code: e.cageCode || null,
            dodaac: e.dodaac || null,
          })),
          source_url: r.url,
          excerpt: `${matches.length} matching entity record(s) on SAM.gov: ${matches.map((e) => e.legalBusinessName).join('; ')}`.slice(0, 500),
        };
      }
      names = r.list.map((e) => e.legalBusinessName).filter(Boolean);
      capped = r.list.length >= SIZE;
      if (!capped) break;
    }

    if (capped) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: sourceUrl,
        excerpt: `the site returned a full list of ${SIZE} names without this company, so absence cannot be shown`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `0 SAM.gov entity records named "${keyword}" (${names.length} other names returned: ${names.slice(0, 3).join('; ')})`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
