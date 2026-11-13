export const meta = {
  task: 'IN-careratings.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'detail_url'],
  canary: { found: 'Tata Chemicals Limited', not_found: 'Zxqwv Nonexistent Holdings Private Limited' },
};

// The site's own header search box calls this JSON endpoint on every keystroke (3+ characters).
// It returns { data: [{ CompanyID, CompanyName }], report: [...] }; data is empty when nothing matches.
const SEARCH_URL = 'https://www.careratings.com/header/searchlist';
const DETAIL_URL = 'https://www.careratings.com/search?Id=';
const HOME_URL = 'https://www.careratings.com/find-ratings';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words that are ignored when comparing names (the site writes e.g. "Tata Chemicals Limited").
const LEGAL_WORDS = new Set(['limited', 'ltd', 'private', 'pvt', 'llp', 'the', 'company', 'co', 'corporation', 'corp', 'inc', 'incorporated']);

/** Lowercase words without accents or punctuation. "&" counts as "and". */
function words(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** The name without legal-form words, used as the comparison key. */
function coreKey(str) {
  return words(str).filter((w) => !LEGAL_WORDS.has(w)).join(' ');
}

/** The site writes some names as "X Limited (Erstwhile Y Limited)": compare the main name and the former name. */
function namesOnSite(name) {
  const main = String(name).replace(/\([^)]*\)/g, ' ');
  const formerNames = (String(name).match(/\(([^)]*)\)/g) || []).map((s) => s.slice(1, -1).replace(/erstwhile|formerly|f\/k\/a/gi, ' '));
  return [main, ...formerNames];
}

function sameCompany(siteName, query) {
  const want = coreKey(query);
  return want !== '' && namesOnSite(siteName).some((n) => coreKey(n) === want);
}

/** True when the keyword has letters in a script other than Latin (e.g. Devanagari). */
function hasNonLatinLetters(str) {
  const letters = String(str || '').match(/\p{L}/gu) || [];
  return letters.some((ch) => !/\p{Script=Latin}/u.test(ch));
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** One call to the site's search endpoint. Returns { url, list } or { failure }. */
async function searchOnce(term) {
  const url = `${SEARCH_URL}?cinput=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': HOME_URL,
    },
    signal: AbortSignal.timeout(25000),
  });

  if (res.status === 403 || res.status === 429) {
    return { failure: fail('blocked', url, `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { failure: fail('http_error', url, `HTTP ${res.status}`) };
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (/captcha|access denied|are you a robot/i.test(text.slice(0, 3000))) {
      return { failure: fail('blocked', url, 'bot or captcha page instead of JSON') };
    }
    return { failure: fail('layout_changed', url, text.slice(0, 300)) };
  }
  if (!json || !Array.isArray(json.data)) {
    return { failure: fail('layout_changed', url, JSON.stringify(json).slice(0, 300)) };
  }
  return { url, list: json.data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const query = String(keyword ?? '').replace(/\s+/g, ' ').trim();
  try {
    if (query.length < 3) {
      return fail('other', HOME_URL, 'keyword is shorter than the 3 characters the site search needs');
    }
    // The site lists companies in Latin script only. A name written in another script cannot be matched,
    // so this is "could not check", never "not listed".
    if (hasNonLatinLetters(query)) {
      return fail('other', HOME_URL, 'the site lists company names in Latin script only; this name is in another script');
    }

    // One search call, with the legal-form words removed ("PVT LTD" typed, "Private Limited" on the site).
    // The site's search matches part of the name, so the core name still finds every company with the same core.
    // (Two sequential fetches with AbortSignal.timeout crash Node 24 on Windows at exit, so only one is made.)
    const isLegalToken = (t) => {
      const parts = t.split(/[.,]/).map((p) => p.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
      return parts.length > 0 && parts.every((p) => LEGAL_WORDS.has(p));
    };
    const coreText = query.split(/\s+/).filter((t) => !isLegalToken(t)).join(' ');
    const searched = await searchOnce(coreText.length >= 3 ? coreText : query);
    if (searched.failure) return searched.failure;
    const list = searched.list;
    const matches = list.filter((o) => sameCompany(o.CompanyName, query));

    if (matches.length > 0) {
      const records = matches.map((o) => ({
        name: String(o.CompanyName).trim(),
        company_id: String(o.CompanyID || ''),
        detail_url: `${DETAIL_URL}${encodeURIComponent(String(o.CompanyID || ''))}`,
      }));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].detail_url,
        excerpt: `CARE Ratings organisation list: ${records.map((r) => r.name).join('; ')}`.slice(0, 500),
      };
    }

    // The search shows at most 10 names. A full list with no exact match may hide the company, so that is not "not listed".
    if (list.length >= 10) {
      return fail('other', searched.url, `the search returned 10 names (the site's maximum), so "${query}" cannot be confirmed as absent`);
    }

    // The site answered normally and no organisation has this name.
    const similar = list.slice(0, 5).map((o) => o.CompanyName).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searched.url,
      excerpt: `No CARE Ratings organisation matches "${query}" (searched: ${searched.url}; the site search does not cover former names written in brackets).` +
        (similar ? ` Similar names returned: ${similar}` : ' The search returned no organisations.'),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', SEARCH_URL, String(err?.message || err));
  }
}
