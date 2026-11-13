export const meta = {
  task: 'GB-caa.co.uk',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'atol_number', 'trading_name', 'list_name', 'has_ceased_trading', 'holder_type',
    'licence_holder_id', 'accredited_body_name', 'accredited_body_atol_number'],
  canary: { found: 'Jet2holidays Ltd', not_found: 'Zyxqorvan Voyages Ltd' },
};

// Same request the "Search ATOL holders" form on https://www.caa.co.uk makes (POST, JSON body).
const API_URL = 'https://aircraftapi.caa.co.uk/api/checkanatol/search';
const PAGE_URL = 'https://www.caa.co.uk/atol-protection/check-an-atol/search-atol-holders/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'lp', 'llc', 'cic', 'cio']);
const LEGAL_SUFFIX = /[\s,.]*\b(ltd|limited|plc|llp|lp|llc|cic|cio)\.?\s*$/i;

/** Lower case, accents off, "&" as "and", punctuation removed, single spaces. */
function normalise(str) {
  return String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalised name without trailing legal form words ("ltd", "limited", ...). */
function coreName(str) {
  const words = normalise(str).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The text sent to the site: the name as typed, legal form removed, max 50 characters (the site's limit). */
function searchTerm(keyword) {
  const typed = String(keyword).trim().replace(/\s+/g, ' ');
  let term = typed;
  let prev;
  do {
    prev = term;
    term = term.replace(LEGAL_SUFFIX, '').trim();
  } while (term !== prev && term.length > 0);
  if (term.length < 2) term = typed;
  return term.slice(0, 50).trim();
}

function toRecord(row) {
  return {
    name: row.companyName || '',
    atol_number: row.atolNumber || '',
    trading_name: row.tradingName || '',
    list_name: row.listName || '',
    has_ceased_trading: row.hasCeasedTrading === true,
    holder_type: row.atolHolderType ?? null,
    licence_holder_id: row.licenceHolderID || '',
    accredited_body_name: row.accreditedBodyCompanyName || '',
    accredited_body_atol_number: row.accreditedBodyAtolNumber || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await runLookup(keyword);
  // Local workaround: on this Windows Node build, process.exit() right after a fetch aborts with a libuv assertion
  // (exit code 127). A short pause lets the socket settle before the runner exits. Costs 0.3 s.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function runLookup(keyword) {
  try {
    const wanted = coreName(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
               excerpt: 'the name has no letters or digits to search for' };
    }
    const term = searchTerm(keyword);
    if (term.length < 2) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
               excerpt: 'the site needs at least 2 characters to search' };
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ AtolNumber: null, Name: term }),
      signal: AbortSignal.timeout(25000),
    });

    const body = await res.text();
    if (res.status === 403 || res.status === 429 || /captcha/i.test(body.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL,
               excerpt: `HTTP ${res.status} for search "${term}"` };
    }

    let rows;
    try {
      rows = JSON.parse(body);
    } catch {
      rows = null;
    }
    if (!Array.isArray(rows)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL,
               excerpt: body.slice(0, 300) };
    }
    if (rows.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
               excerpt: `No ATOL holder matched "${term}"` };
    }

    // The search is a loose "contains" match, so keep only rows whose company, list or trading name is the same name.
    const seen = new Set();
    const records = [];
    for (const row of rows) {
      const same = [row.companyName, row.listName, row.tradingName].some((n) => coreName(n) === wanted);
      if (!same) continue;
      const rec = toRecord(row);
      const key = `${rec.licence_holder_id}|${rec.atol_number}|${rec.list_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
               excerpt: `${rows.length} loose matches for "${term}", none with this company name` };
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE_URL,
      excerpt: `${first.name} | ATOL ${first.atol_number} | ${records.length} listing(s) | ceased trading: ${first.has_ceased_trading ? 'yes' : 'no'}`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
