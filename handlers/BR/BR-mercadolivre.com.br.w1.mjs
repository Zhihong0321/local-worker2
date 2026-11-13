export const meta = { task: 'BR-mercadolivre.com.br', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'official_store_id', 'permalink', 'categories_ids'],
  canary: { found: 'Samsung', not_found: 'Empresa Fantasma Brasil Ltda' } };

// Mercado Livre's own official-stores search API (the one the /lojas-oficiais/catalogo page calls).
// It matches official store names (the store's public name), not legal names, so the company name is
// reduced to its core name (legal form removed) before the search, and a result counts only if its
// store name is the same as that core name.
const SEARCH = 'https://www.mercadolivre.com.br/lojas-oficiais/api/sites/MLB/brands/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = ['ltda', 'eireli', 'ltd', 'mei', 'epp', 'me', 'sa'];

/** lower case, no accents, only a-z0-9 words separated by single spaces */
function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** core name: normalised, with a trailing legal form ("ltda", "s a", "me" ...) removed */
function coreName(str) {
  const t = normalize(str).split(' ').filter(Boolean);
  let changed = true;
  while (changed && t.length > 1) {
    changed = false;
    const last = t[t.length - 1];
    const prev = t[t.length - 2];
    if (LEGAL_FORMS.includes(last)) {
      t.pop(); changed = true;
    } else if (prev === 's' && last === 'a') {
      t.pop(); t.pop(); changed = true;
    }
  }
  return t.join(' ');
}

async function lookupOnce(keyword) {
  let url = SEARCH;
  let timer = null;
  try {
    const q = coreName(keyword);
    if (!q) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH, excerpt: 'empty company name' };
    }
    url = `${SEARCH}?q=${encodeURIComponent(q)}&limit=100&platformId=ML`;

    const ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), 25000);
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: ctl.signal,
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url,
        excerpt: String(err?.message || err).slice(0, 300) };
    }

    // a bot check or login wall sends the request to an account-verification page
    if (res.url && /account-verification|\/gz\//.test(res.url)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `redirected to ${res.url}`.slice(0, 300) };
    }
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || !data.paging || !Array.isArray(data.results)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 300) };
    }

    const total = Number(data.paging.total);
    const results = data.results;
    const matches = results.filter((r) => r && (coreName(r.name) === q || coreName(r.normalized_name) === q));

    if (matches.length > 0) {
      const records = matches.map((r) => ({
        name: r.name,
        official_store_id: r.official_store_id ?? null,
        permalink: r.permalink || '',
        categories_ids: Array.isArray(r.categories_ids) ? r.categories_ids : [],
      }));
      return { status: 'found', reason: '', records, source_url: url,
        excerpt: JSON.stringify(records).slice(0, 500) };
    }

    // no exact match, but the search had more hits than this one page: cannot say it is absent
    if (Number.isFinite(total) && total > results.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: url,
        excerpt: `search returned ${total} results, only the first ${results.length} were checked, none exact` };
    }

    return { status: 'not_found', reason: '', records: [], source_url: url,
      excerpt: `0 official stores named "${q}" (search total ${total})` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: url,
      excerpt: String(err?.message || err).slice(0, 300) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Windows Node 24 aborts on exit (libuv assertion) when the runner exits right after a fetch with a custom
  // header; a short pause lets the connection close first. The answer itself is not affected.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}
