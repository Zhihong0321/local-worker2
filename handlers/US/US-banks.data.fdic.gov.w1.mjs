export const meta = {
  task: 'US-banks.data.fdic.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'cert', 'active', 'city', 'state', 'address', 'zip', 'established', 'insured_date', 'primary_regulator', 'holding_company', 'report_date'],
  canary: { found: 'JPMorgan Chase Bank, National Association', not_found: 'Xqzvbnqwrt Imaginary Trust Company' },
};

// The BankFind Suite page (banks.data.fdic.gov/bankfind-suite/) is a JavaScript shell. Its own script reads the
// same public JSON API that is used here: api.fdic.gov/banks/institutions (no key, no login).
const API = 'https://api.fdic.gov/banks/institutions';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIELDS = 'NAME,CERT,ACTIVE,CITY,STALP,ADDRESS,ZIP,ESTYMD,INSDATE,REGAGNT,NAMEHCR,REPDTE';
// Legal-form words, dropped from the end of a name (and "the" from the start) before two names are compared.
const LEGAL_TAIL = new Set(['national', 'association', 'na', 'n', 'a', 'inc', 'incorporated', 'llc', 'ltd', 'limited',
  'corp', 'corporation', 'co', 'company', 'plc', 'fsb', 'sa', 'nv', 'bv', 'pllc', 'lp', 'llp', 'and']);

function tokens(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Name without leading "the" and trailing legal-form words, e.g. "Bank of America, N.A." -> "bank of america". */
function core(toks) {
  const t = [...toks];
  if (t[0] === 'the') t.shift();
  while (t.length > 1 && LEGAL_TAIL.has(t[t.length - 1])) t.pop();
  return t;
}

function couldnt(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On the test PC (Windows, Node 24) the runner calls process.exit() right after this returns, and that aborts
  // with "UV_HANDLE_CLOSING" (exit 127) while the HTTP sockets are still closing. A short pause lets them close.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  let url = API;
  try {
    const wanted = core(tokens(keyword));
    if (wanted.length === 0) return couldnt('other', 'no company name left after removing legal-form words', url);
    const wantedKey = wanted.join(' ');

    url = `${API}?search=${encodeURIComponent(`NAME:"${wantedKey}"`)}&fields=${FIELDS}&limit=100`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, url);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, url);

    const text = await res.text();
    if (/captcha|access denied|are you a robot|just a moment/i.test(text.slice(0, 2000))) {
      return couldnt('blocked', 'bot or captcha page: ' + text.slice(0, 200), url);
    }
    let body;
    try { body = JSON.parse(text); } catch { return couldnt('layout_changed', 'not JSON: ' + text.slice(0, 200), url); }
    if (!body || !Array.isArray(body.data) || !body.totals || typeof body.totals.count !== 'number') {
      return couldnt('layout_changed', 'JSON has no data list: ' + text.slice(0, 200), url);
    }

    const matches = body.data
      .map((row) => row && row.data)
      .filter((d) => d && typeof d.NAME === 'string' && core(tokens(d.NAME)).join(' ') === wantedKey);

    if (matches.length === 0) {
      if (body.totals.count > body.data.length) {
        return couldnt('other', `search returned ${body.totals.count} results, only ${body.data.length} were checked`, url);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `0 FDIC institutions match "${keyword}" (search returned ${body.totals.count} results, none with the same name)`,
      };
    }

    const records = matches.map((d) => ({
      name: d.NAME,
      cert: String(d.CERT ?? ''),
      active: d.ACTIVE === 1 ? 'active' : 'inactive',
      city: d.CITY || '',
      state: d.STALP || '',
      address: d.ADDRESS || '',
      zip: d.ZIP || '',
      established: d.ESTYMD || '',
      insured_date: d.INSDATE || '',
      primary_regulator: d.REGAGNT || '',
      holding_company: d.NAMEHCR || '',
      report_date: d.REPDTE || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: records.map((r) => `${r.name} (CERT ${r.cert}, ${r.active}, ${r.city}, ${r.state})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'TimeoutError' || name === 'AbortError') return couldnt('timeout', 'no answer in 25 s', url);
    return couldnt('other', String(err?.message || err), url);
  }
}
