export const meta = {
  task: 'TW-cakeresume.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'path', 'address', 'number_of_employees', 'sector', 'locations', 'last_active_at'],
  canary: { found: 'Realtek 瑞昱半導體', not_found: '零零零虛構科技股份有限公司' },
};

// cakeresume.com now redirects to cake.me; the company search lives on cake.me.
const BASE = 'https://www.cake.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_WORDS = new Set(['sdn', 'bhd', 'berhad', 'pte', 'ltd', 'limited', 'co', 'corp', 'corporation', 'inc', 'llc', 'gmbh', 'plc', 'pt', 'ctcp', 'tbk', 'jsc']);
const CJK_SUFFIXES = ['股份有限公司', '有限責任公司', '有限公司', '公司'];

/** Normalise for comparison: NFKC, lower case, punctuation removed, legal-form words dropped, no spaces. */
function core(str) {
  let s = String(str || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  s = s.split(' ').filter((t) => t && !LEGAL_WORDS.has(t)).join('');
  for (const suf of CJK_SUFFIXES) {
    if (s.endsWith(suf) && s.length > suf.length) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

/** Search term: the keyword with a trailing legal form removed (the site's search is fuzzy and does not match legal forms). */
function searchTerm(keyword) {
  let t = String(keyword || '').trim();
  const pattern = /\s*(股份有限公司|有限責任公司|有限公司|公司|sdn\.?\s*bhd\.?|berhad|pte\.?\s*ltd\.?|co\.?,?\s*ltd\.?|corporation|corp\.?|inc\.?|llc|gmbh|limited|ltd\.?|plc|ctcp|tbk|jsc)\s*$/i;
  let prev;
  do { prev = t; t = t.replace(pattern, '').trim(); } while (t !== prev && t.length > 0);
  return t || String(keyword || '').trim();
}

/** Same company: the normalised keyword equals the normalised entity name, or one of its space-separated parts. */
function matches(keyword, entityName) {
  const k = core(keyword);
  if (!k) return false;
  if (core(entityName) === k) return true;
  return String(entityName || '').split(/\s+/).some((part) => core(part) === k);
}

async function runSearch(term) {
  const url = `${BASE}/companies?q=${encodeURIComponent(term)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    let state = null;
    if (m) {
      try { state = JSON.parse(m[1])?.props?.pageProps?.initialState?.companySearch || null; } catch (e) { state = null; }
    }
    if (state && state.search && state.search.query === term) {
      // A 404 from the site with a valid, empty search state is the normal "no results" answer.
      const view = Object.values(state.viewsByFilterKey || {})[0] || {};
      const total = Number(view.pagination?.total_entries ?? 0);
      const paths = view.pageMap?.['1'] || [];
      const entities = paths.map((p) => state.entityByPathId?.[p]).filter(Boolean);
      return { url, term, ok: true, total, entities };
    }
    if (res.status === 403 || res.status === 429 || /cf-chl|Just a moment|captcha/i.test(html.slice(0, 20000))) {
      return { url, term, ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) return { url, term, ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    return { url, term, ok: false, reason: 'layout_changed', excerpt: html.slice(0, 300) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, term, ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    if (!core(input)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + '/companies', excerpt: 'empty company name' };
    }
    const terms = [...new Set([searchTerm(input), input])];
    const answers = await Promise.all(terms.map(runSearch));

    const seen = new Set();
    const hits = [];
    for (const a of answers) {
      if (!a.ok) continue;
      for (const e of a.entities) {
        if (!seen.has(e.path) && matches(input, e.name)) { seen.add(e.path); hits.push(e); }
      }
    }

    if (hits.length) {
      const first = hits[0];
      return {
        status: 'found',
        reason: '',
        records: hits.map((e) => ({
          name: e.name,
          path: e.path,
          address: e.address || '',
          number_of_employees: e.numberOfEmployees || '',
          sector: e.sector || '',
          locations: (e.locationsWithLocale || []).map((l) => l.nameEn || l.name),
          last_active_at: e.lastActiveAt || '',
        })),
        source_url: `${BASE}/companies/${first.path}`,
        excerpt: `search "${searchTerm(input)}" listed "${first.name}"`.slice(0, 500),
      };
    }

    const failed = answers.find((a) => !a.ok);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.reason, records: [], source_url: failed.url, excerpt: failed.excerpt || '' };
    }
    const okAnswers = answers.filter((a) => a.ok);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: okAnswers[0].url,
      excerpt: okAnswers.map((a) => `q="${a.term}": ${a.total} results, none is this company`).join('; ').slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + '/companies', excerpt: String(err?.message || err).slice(0, 300) };
  }
}
