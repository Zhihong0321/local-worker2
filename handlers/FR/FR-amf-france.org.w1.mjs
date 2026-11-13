export const meta = { task: 'FR-amf-france.org', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'jeton'],
  canary: { found: 'TOTALENERGIES SE', not_found: 'Société Inexistante Zéphyr' } };

// BDIF (AMF) company search. The page at https://bdif.amf-france.org/fr/societes-search calls this JSON endpoint:
//   GET /back/api/Autocomplete?Research=<text>&TypeDonneesAutocomplete=1   (1 = companies, enum "Societes")
// Response: { informationsResult: [], societesResult: [{ jeton, raisonSociale, role }] }, at most 10 rows per query.
// The site is case-insensitive but accent-sensitive, so the query is sent accent-free and upper-case.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://bdif.amf-france.org/back/api/Autocomplete';
const SITE = 'https://bdif.amf-france.org/';
const ROW_CAP = 10;
const LEGAL = new Set(['SA', 'SAS', 'SASU', 'SARL', 'EURL', 'SE', 'SCA', 'SCOP', 'SCI', 'SNC', 'GIE', 'SRL', 'SPA', 'SL',
  'LTD', 'LIMITED', 'INC', 'LLC', 'LLP', 'PLC', 'GMBH', 'AG', 'BV', 'NV']);
const ARTICLES = new Set(['L', 'LE', 'LA', 'LES']);

/** Upper-case, accents off, dots removed, single spaces: the form the site search expects. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: no case, accents, punctuation, leading article or trailing legal form. */
function norm(name) {
  const t = fold(name).replace(/['’`]/g, ' ').replace(/[^A-Z0-9 ]+/g, ' ').split(' ').filter(Boolean);
  if (t.length > 1 && ARTICLES.has(t[0])) t.shift();
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** Search texts to send: the name as typed, then the same name without its legal form (if different). */
function queryForms(input) {
  const full = fold(input);
  const words = full.split(' ');
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  const core = words.join(' ');
  return [...new Set([full, core])].filter(Boolean);
}

async function getJson(url) {
  let res;
  let text;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
    if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
    text = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { fail: { reason: timeout ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 300) } };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    if (/captcha|access denied|cloudflare|challenge/i.test(text.slice(0, 3000))) {
      return { fail: { reason: 'blocked', excerpt: text.replace(/\s+/g, ' ').slice(0, 300) } };
    }
    return { fail: { reason: 'layout_changed', excerpt: text.replace(/\s+/g, ' ').slice(0, 300) } };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  let lastUrl = `${SITE}fr/societes-search`;
  try {
    if (!input) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl, excerpt: 'empty company name' };
    }
    const target = norm(input);
    let capped = false;
    let rowsSeen = 0;
    let lastQuery = '';
    let matchUrl = '';
    const matches = new Map();

    for (const q of queryForms(input)) {
      const url = `${API}?Research=${encodeURIComponent(q)}&TypeDonneesAutocomplete=1`;
      lastUrl = url;
      lastQuery = q;
      const got = await getJson(url);
      if (got.fail) {
        return { status: 'couldnt_check', reason: got.fail.reason, records: [], source_url: url, excerpt: got.fail.excerpt };
      }
      const rows = got.data && Array.isArray(got.data.societesResult) ? got.data.societesResult : null;
      if (!rows) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
          excerpt: JSON.stringify(got.data).slice(0, 300) };
      }
      rowsSeen = rows.length;
      for (const row of rows) {
        if (row && row.jeton && norm(row.raisonSociale) === target && !matches.has(row.jeton)) {
          matches.set(row.jeton, { name: row.raisonSociale, jeton: row.jeton });
          matchUrl = url;
        }
      }
      if (matches.size) break;
      if (rows.length >= ROW_CAP) capped = true;
    }

    if (matches.size) {
      const records = [...matches.values()];
      return { status: 'found', reason: '', records, source_url: matchUrl, excerpt: JSON.stringify(records).slice(0, 500) };
    }
    if (capped) {
      // The site stops at 10 rows; the company may sit beyond them, so absence is not proven.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
        excerpt: `search for "${lastQuery}" returned the site's ${ROW_CAP}-row maximum with no exact name match` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: lastUrl,
      excerpt: `search for "${lastQuery}" returned ${rowsSeen} company row(s), none named "${input}"` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
