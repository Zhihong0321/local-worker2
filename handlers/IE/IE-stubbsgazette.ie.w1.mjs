export const meta = {
  task: 'IE-stubbsgazette.ie',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'number', 'address', 'country', 'status', 'date_of_last_accounts', 'record_type'],
  canary: { found: 'COASTAL ZONE SERVICES LIMITED', not_found: 'Zqxvbrk Plorn Neamhliostaithe Teoranta' },
};

const ENDPOINT = 'https://www.stubbsgazette.ie/search/suggestions';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Legal-form words stripped from the end of a name before comparing (Irish and English forms).
const LEGAL_SUFFIXES = [
  'DESIGNATED ACTIVITY COMPANY', 'UNLIMITED COMPANY', 'COMPANY LIMITED BY GUARANTEE', 'LIMITED BY GUARANTEE',
  'LIMITED', 'LTD', 'TEORANTA', 'TEO', 'DAC', 'CLG', 'PLC', 'UC',
];

/** Upper-case, no accents, no punctuation, no legal form: "Coastal Zone Services Ltd." -> "COASTAL ZONE SERVICES". */
function coreName(s) {
  let t = (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (t !== suf && t.endsWith(' ' + suf)) {
        t = t.slice(0, -(suf.length + 1)).trim();
        changed = true;
      }
    }
  }
  return t;
}

function recordType(code) {
  return code === 1 ? 'company' : code === 2 ? 'business name' : String(code ?? '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword ?? '').trim();
  const wanted = coreName(input);
  if (!wanted) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT, excerpt: 'empty company name' };
  }
  try {
    const body = new URLSearchParams({ srch_strng: input, srch_r: 'roi', srch_t: 'com', srch_nmbr: '', srch_ddrss: '', srch_xtrs: '' });
    const res = await fetch(`${ENDPOINT}?cll_tkn=${Math.floor(Math.random() * 1e9)}`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.stubbsgazette.ie/',
        'Origin': 'https://www.stubbsgazette.ie',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: ENDPOINT, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: ENDPOINT, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|g-recaptcha|cf-chl|Just a moment/i.test(text) || /login/i.test(res.url || '')) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: ENDPOINT, excerpt: text.slice(0, 200) };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: ENDPOINT, excerpt: text.slice(0, 200) };
    }
    if (!data || typeof data !== 'object' || !data.records || typeof data.records !== 'object' || !('result' in data.records)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: ENDPOINT, excerpt: text.slice(0, 200) };
    }

    // The site returns one object instead of an array when there is only one hit (see its own cb.angular.js).
    const raw = data.records.result;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];

    const matches = list.filter((r) => r && typeof r.name === 'string' && coreName(r.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: ENDPOINT,
        excerpt: `site returned ${list.length} other result(s); none named "${input}"`,
      };
    }

    const records = matches.map((r) => ({
      name: r.name,
      number: r.number ?? '',
      address: r.address ?? '',
      country: r.country ?? '',
      status: r.status ?? '',
      date_of_last_accounts: r.dateoflastaccounts ?? '',
      record_type: recordType(r.record_type),
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: ENDPOINT,
      excerpt: records.map((r) => `${r.name} | ${r.number} | ${r.status}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: ENDPOINT,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
