export const meta = {
  task: 'IE-highcourtsearch.courts.ie',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'case_ref', 'case_title', 'party_role', 'date_issued', 'legal_firm'],
  canary: { found: 'RYANAIR DESIGNATED ACTIVITY COMPANY', not_found: 'Comhlacht Neamhaimsithe Teoranta' },
};

// The High Court search page (www.courts.ie/high-court-search) posts its form to this JSON endpoint.
// highcourtsearch.courts.ie itself only redirects to courts.ie, so the endpoint is called directly.
const ENDPOINT = 'https://www.courts.ie/high-court-search/GetCases/';
const PAGE_URL = 'https://www.courts.ie/high-court-search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 8;          // pages of results read per search string
const START_BUDGET_MS = 20000; // no new request starts after this, so the whole call stays under 60 s

// Legal forms are removed before two names are compared ("ACME LTD" = "Acme Limited" = "ACME").
const LEGAL_PHRASES = ['designated activity company', 'public limited company', 'unlimited company'];
const LEGAL_WORDS = new Set(['dac', 'limited', 'ltd', 'plc', 'teoranta', 'teo', 'ulc', 'clg', 'company', 'co', 'inc', 'llp', 'sdn', 'bhd']);

function core(name) {
  let s = ' ' + String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9À-ɏ]+/g, ' ').trim() + ' ';
  for (const p of LEGAL_PHRASES) s = s.split(' ' + p + ' ').join(' ');
  return s.split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

function formBody(name, page) {
  return new URLSearchParams({
    page: String(page), proceeding: '', caseRef: '', caseNumber: '', year: '',
    caseparty1: name, caseparty1checked: 'Both', caseparty2: '', caseparty2checked: 'Both',
    setDownVenue: '', setDownType: '', setdownNumFrom: '', courtdate: '', listType: '',
    appealcasereference: '', supremecasereference: '', sortBy: '',
  }).toString();
}

/** One page of results. Returns { data } or { fail } where fail is a couldnt_check answer. */
async function fetchPage(name, page) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-IE,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE_URL,
      },
      body: formBody(name, page),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: ENDPOINT, excerpt: String(err?.message || err).slice(0, 200) } };
  }
  if (res.status === 403 || res.status === 429) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: ENDPOINT, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: ENDPOINT, excerpt: `HTTP ${res.status}` } };
  }
  const text = await res.text();
  if (text.startsWith('Invalid access')) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: ENDPOINT, excerpt: text.slice(0, 200) } };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: ENDPOINT, excerpt: text.replace(/\s+/g, ' ').slice(0, 300) } };
  }
  if (!data || data.status !== true || (data.results !== null && !Array.isArray(data.results))) {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: ENDPOINT, excerpt: JSON.stringify(data).slice(0, 300) } };
  }
  return { data };
}

/** Every matching party in one search string's results. Returns { matches, complete, total, seen } or { fail }. */
async function searchName(name, target, startedAt) {
  const matches = [];
  let page = 1, total = 0, seen = 0;
  for (;;) {
    const r = await fetchPage(name, page);
    if (r.fail) return { fail: r.fail };
    const results = r.data.results || [];
    total = Number(r.data.total) || 0;
    seen += results.length;
    for (const c of results) {
      for (const party of c.case_parties || []) {
        const names = [party.arch_name, party.arch_companyname].filter(Boolean);
        if (!names.some((n) => core(n) === target)) continue;
        matches.push({
          name: party.arch_name || party.arch_companyname,
          case_ref: c.arch_name || '',
          case_title: c.arch_publiccasetitle || '',
          party_role: party.arch_caserole?.arch_name || '',
          date_issued: c.arch_dateofissue || '',
          legal_firm: party.arch_legalfirm?.arch_name || '',
        });
      }
    }
    const more = results.length > 0 && seen < total;
    if (!more) break;
    if (page >= MAX_PAGES || Date.now() - startedAt > START_BUDGET_MS) {
      return { matches, complete: false, total, seen };
    }
    page++;
  }
  return { matches, complete: true, total, seen };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node on Windows aborts (exit 127) when the runner calls process.exit() while fetch keep-alive sockets are
  // still open. Waiting 5 s lets idle sockets close first. Adds 5 s; the whole call stays under 60 s.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const typed = String(keyword || '').replace(/\s+/g, ' ').trim();
    const target = core(typed);
    if (!typed || !target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT, excerpt: 'no company name given' };
    }
    // Search the name as typed first, then the name without its legal form (the site may write "RYANAIR DAC").
    const queries = [typed];
    if (target !== typed.toLowerCase()) queries.push(target);

    const startedAt = Date.now();
    const seenKeys = new Set();
    const records = [];
    let allComplete = true, lastTotal = 0, lastSeen = 0;
    for (const q of queries) {
      const r = await searchName(q, target, startedAt);
      if (r.fail) return r.fail;
      lastTotal = r.total; lastSeen = r.seen;
      if (!r.complete) allComplete = false;
      for (const m of r.matches) {
        const k = m.case_ref + '|' + m.name;
        if (!seenKeys.has(k)) { seenKeys.add(k); records.push(m); }
      }
      if (records.length) break;
    }

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: ENDPOINT,
        excerpt: `${records.length} case(s) name "${records[0].name}" as a party; e.g. ${records[0].case_ref}: ${records[0].case_title}`.slice(0, 500),
      };
    }
    if (allComplete) {
      return {
        status: 'not_found', reason: '', records: [], source_url: ENDPOINT,
        excerpt: `0 matching party names for "${typed}" (search returned ${lastTotal} case(s) for the last search string)`,
      };
    }
    return {
      status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT,
      excerpt: `no match in the first ${lastSeen} of ${lastTotal} results; the rest were not read in time`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
