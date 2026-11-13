export const meta = {
  task: 'GB-creditsafe.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'safe_no', 'status', 'type', 'date_of_latest_change', 'address', 'street', 'city', 'postcode'],
  canary: { found: 'TESCO PLC', not_found: 'Zqxvkwbl Fjorsentam Holdings Ltd' },
};

// Public free-report page (the site's own company-name search form) and the JSON search the page calls.
// The search answers with an empty body unless the browser first holds the session cookies from the form page.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FORM_URL = 'https://www.creditsafe.com/gb/en/forms/free-report.html';
const SEARCH_BASE = 'https://www.creditsafe.com/content/creditsafe.connectgetcompanies.html';

const FORMS = ['PLC', 'LTD', 'LLP'];

/** Upper-case, punctuation to spaces, legal-form wording to its short form. */
function canonical(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/\b(?:[A-Z]\.){2,}[A-Z]?\b\.?/g, (m) => m.replace(/\./g, ''))
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\bPUBLIC LIMITED COMPANY\b/g, 'PLC')
    .replace(/\bLIMITED LIABILITY PARTNERSHIP\b/g, 'LLP')
    .replace(/\bLIMITED\b/g, 'LTD');
}

function splitForm(canon) {
  const parts = canon.split(' ').filter(Boolean);
  const last = parts[parts.length - 1];
  if (FORMS.includes(last)) return { base: parts.slice(0, -1).join(' '), form: last };
  return { base: canon, form: '' };
}

/** Same company name: equal after normalising. A keyword without a legal form also accepts any legal form. */
function isSameName(keywordCanon, candidateName) {
  const cand = canonical(candidateName);
  if (cand === keywordCanon) return true;
  const kw = splitForm(keywordCanon);
  if (kw.form) return false;
  return splitForm(cand).base === kw.base;
}

function setCookiePairs(headers) {
  let raw = [];
  if (typeof headers.getSetCookie === 'function') {
    raw = headers.getSetCookie();
  } else {
    const joined = headers.get('set-cookie');
    if (joined) raw = joined.split(/,(?=\s*[^;,=\s]+=)/);
  }
  return raw.map((s) => String(s).split(';')[0].trim()).filter((p) => p.includes('='));
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const searchUrl = `${SEARCH_BASE}?name=${encodeURIComponent(encodeURIComponent(name))}&page=1&countries=gb`;
  try {
    const kwCanon = canonical(name);
    if (kwCanon.replace(/ /g, '').length < 3) {
      return couldnt('other', searchUrl, 'name shorter than 3 characters (the site needs at least 3)');
    }

    // Step 1: open the public form page to collect its session cookies.
    const formRes = await fetch(FORM_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (formRes.status === 403 || formRes.status === 429) {
      return couldnt('blocked', FORM_URL, `HTTP ${formRes.status}`);
    }
    if (!formRes.ok) {
      return couldnt('http_error', FORM_URL, `HTTP ${formRes.status}`);
    }
    const cookies = setCookiePairs(formRes.headers);
    await formRes.text();

    // Step 2: the same JSON search the form's company-name box calls.
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': FORM_URL,
        ...(cookies.length ? { 'Cookie': cookies.join('; ') } : {}),
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return couldnt('blocked', searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return couldnt('http_error', searchUrl, `HTTP ${res.status}`);
    }

    const body = await res.text();
    if (!body.trim()) {
      return couldnt('other', searchUrl, 'empty response from the search (no answer body)');
    }
    if (body.trimStart().startsWith('<')) {
      if (/captcha|access denied|forbidden|challenge/i.test(body)) return couldnt('blocked', searchUrl, body.slice(0, 300));
      return couldnt('layout_changed', searchUrl, body.slice(0, 300));
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return couldnt('layout_changed', searchUrl, body.slice(0, 300));
    }
    if (!data || !Array.isArray(data.companies)) {
      return couldnt('layout_changed', searchUrl, body.slice(0, 300));
    }

    // The search is fuzzy: it returns similar names too. Keep only the same company name.
    const matches = data.companies.filter((c) => c && typeof c.name === 'string' && isSameName(kwCanon, c.name));
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `search returned ${data.companies.length} similar name(s), none with this exact name`,
      };
    }

    const records = matches.map((c) => {
      const a = c.address || {};
      return {
        name: c.name,
        company_id: c.id || '',
        safe_no: c.safeNo || '',
        status: c.status || '',
        type: c.type || '',
        date_of_latest_change: c.dateOfLatestChange || '',
        address: a.simpleValue || '',
        street: a.street || '',
        city: a.city || '',
        postcode: a.postCode || '',
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: JSON.stringify(matches[0]).slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
