export const meta = {
  task: 'ID-karir.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'company_page', 'active_postings'],
  canary: { found: 'PT Pesonna Indonesia Jaya', not_found: 'PT Zelvora Nusantara Sejahtera' },
};

// karir.com's own search page calls this JSON API (POST) with the typed keyword. It returns job postings;
// each posting carries company_name and company_id. A company counts as found when a posting's company name
// matches the typed name after normalising case, punctuation and legal form.
const SEARCH_API = 'https://karir-ms-beta.karir.com/v2/search/opportunities';
const PUBLIC_SEARCH = 'https://karir.com/search-lowongan?keyword=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;
const MAX_PAGES = 4;
const PAGE_START_LIMIT_MS = 30000; // do not start another page after 30 s (keeps the whole call under 60 s)
const LEGAL_FORMS = new Set(['pt', 'cv', 'tbk', 'persero', 'ud', 'perum', 'firma', 'fa', 'koperasi']);

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

/** Normalised forms of a name: the full name, and the name without a bracketed part such as "(DIKA)". */
function variants(s) {
  const raw = String(s || '');
  const out = new Set();
  const full = normName(raw);
  if (full) out.add(full);
  const noBrackets = normName(raw.replace(/\([^)]*\)/g, ' '));
  if (noBrackets) out.add(noBrackets);
  return [...out];
}

async function searchPage(keyword, offset) {
  const res = await fetch(SEARCH_API, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Origin': 'https://karir.com',
      'Referer': 'https://karir.com/',
    },
    body: JSON.stringify({ keyword, limit: PAGE, offset, locale: 'id' }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) {
    return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
  }
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { fail: { reason: 'layout_changed', excerpt: text.slice(0, 300) } };
  }
  if (!j || j.code !== 200 || !j.data || typeof j.data.total_count !== 'number') {
    return { fail: { reason: 'layout_changed', excerpt: JSON.stringify(j).slice(0, 300) } };
  }
  const opportunities = Array.isArray(j.data.opportunities) ? j.data.opportunities : [];
  return { total: j.data.total_count, opportunities };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const typed = String(keyword || '').trim();
  const source_url = PUBLIC_SEARCH + encodeURIComponent(typed);
  try {
    const wanted = variants(typed);
    if (wanted.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'empty company name' };
    }

    const started = Date.now();
    const matches = new Map(); // company_id -> record
    let total = null;
    let offset = 0;
    let pages = 0;

    while (pages < MAX_PAGES) {
      if (pages > 0 && Date.now() - started > PAGE_START_LIMIT_MS) break;
      const page = await searchPage(typed, offset);
      if (page.fail) {
        return { status: 'couldnt_check', reason: page.fail.reason, records: [], source_url, excerpt: page.fail.excerpt };
      }
      total = page.total;
      pages++;
      for (const opp of page.opportunities) {
        const companyVariants = variants(opp.company_name);
        if (!companyVariants.some((v) => wanted.includes(v))) continue;
        const id = String(opp.company_id ?? '');
        if (!matches.has(id)) {
          matches.set(id, {
            name: opp.company_name,
            company_id: id,
            company_page: id ? `https://karir.com/company-detail/${id}` : '',
            active_postings: 0,
          });
        }
        matches.get(id).active_postings++;
      }
      offset += PAGE;
      if (page.opportunities.length === 0 || offset >= total) break;
    }

    if (matches.size > 0) {
      const records = [...matches.values()];
      return {
        status: 'found',
        reason: '',
        records,
        source_url,
        excerpt: `${records.length} company match(es) for "${typed}" in ${total} search results: ${records.map((r) => `${r.name} (id ${r.company_id}, ${r.active_postings} postings)`).join('; ')}`.slice(0, 500),
      };
    }

    const coveredAll = total === 0 || offset >= total;
    if (coveredAll) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: `0 companies named "${typed}" among ${total} search results`,
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url,
      excerpt: `search returned ${total} postings; only the first ${offset} were checked, no company named "${typed}" among them`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
