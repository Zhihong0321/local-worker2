export const meta = {
  task: 'CA-chamber.ca',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'city', 'province', 'industry', 'domain', 'phone', 'membership_type', 'membership_state', 'hubspot_id'],
  canary: { found: 'IBM Canada ltd.', not_found: 'Société Entreprise Inexistante Québec Inc.' },
};

// The Business Member Directory (Corporate members) loads its results with a POST to WordPress admin-ajax.php.
// No token or nonce is needed for the search.
const ENDPOINT = 'https://www.chamber.ca/wp-admin/admin-ajax.php';
const PAGE_URL = 'https://www.chamber.ca/membership/business-member-directory/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10;
const BUDGET_MS = 40000; // stop paging early so the whole call stays under 60 s
const LEGAL = new Set(['ltd', 'lt', 'ltee', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'llc', 'llp', 'lp', 'ulc', 'sa']);

/** Lower case, no accents, no punctuation: "Fédération des Caisses, Ltée" -> "federation des caisses ltee". */
function fold(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&amp;|&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The name without a trailing legal form: "IBM Canada Ltd." -> "IBM Canada". Keeps the original spelling for the search. */
function coreName(s) {
  const words = String(s || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL.has(fold(words[words.length - 1]))) words.pop();
  return words.join(' ').replace(/[,;]+$/, '').trim();
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt).slice(0, 300) };
}

function record(p, r) {
  return {
    name: p.name || '',
    city: p.city || '',
    province: p.province || '',
    industry: p.industry || '',
    domain: p.domain || '',
    phone: p.phone || '',
    membership_type: p.membership_type || '',
    membership_state: p.membership_state || '',
    hubspot_id: String(r.id || p.hs_object_id || ''),
  };
}

async function fetchPage(search, page) {
  const body = new URLSearchParams({
    action: 'get_chamber_companies',
    page: String(page),
    membership_type: 'Corporate',
    search,
    searchKey: 'name',
  });
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': PAGE_URL,
    },
    body,
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const core = coreName(keyword);
    const want = fold(core);
    if (!want) return fail('other', 'empty or unreadable company name');

    const started = Date.now();
    const matches = [];
    let total = 0;
    let seen = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > BUDGET_MS) break;

      const res = await fetchPage(core, page);
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        const blocked = /captcha|challenge|verify you are human|access denied/i.test(text);
        return fail(blocked ? 'blocked' : 'layout_changed', text.slice(0, 200));
      }

      const data = json && json.data;
      if (json.success !== true || !data || typeof data.total !== 'number' || !Array.isArray(data.results)) {
        return fail('layout_changed', text.slice(0, 200));
      }

      total = data.total;
      // The site answers "No results found" with total 0: the directory answered normally and the name is not there.
      if (total === 0) {
        return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
                 excerpt: `0 Corporate member results for "${core}"` };
      }

      for (const r of data.results) {
        const p = (r && r.properties) || {};
        if (p.name && fold(coreName(p.name)) === want) matches.push(record(p, r));
      }

      seen += data.results.length;
      if (data.results.length === 0 || seen >= total) break;
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: PAGE_URL,
        excerpt: matches.map((m) => m.name).join(' | ').slice(0, 300),
      };
    }

    if (seen < total) {
      return fail('other', `${total} directory entries match "${core}"; only ${seen} were checked`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `${total} Corporate member result(s) for "${core}", none with this name`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String((err && err.message) || err));
  }
}
