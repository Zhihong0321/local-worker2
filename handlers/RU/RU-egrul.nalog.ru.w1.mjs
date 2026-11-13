export const meta = {
  task: 'RU-egrul.nalog.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'short_name', 'inn', 'ogrn', 'kpp', 'kind', 'registration_date', 'termination_date', 'region', 'head'],
  canary: { found: 'ПАО СБЕРБАНК', not_found: 'Ъъъ Жжжщщщ Фффюююэээ' },
};

// Flow seen on the site (egrul.nalog.ru/js/index.js):
//   1. POST https://egrul.nalog.ru/  (form fields query, region, PreventChromeAutocomplete, page)
//      -> {"t": "<token>", "captchaRequired": false}
//   2. GET  https://egrul.nalog.ru/search-result/<t>  -> {"rows": [...]} (or {"status":"wait"} while working)
//      Each row: n = full name, c = short name, i = INN, o = OGRN, p = KPP, k = kind (ul / ip / fl),
//      r = registration date, e = termination date, rn = region, g = head. 20 rows per page; cnt = total results.
const SITE = 'https://egrul.nalog.ru/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;
const MAX_PAGES = 5;        // at most 100 results are compared; more than that is couldnt_check, never not_found
const DEADLINE_MS = 55000;  // the whole call must finish in under 60 s

// Legal form words -> one code. Matching the form is part of the company match.
const FORM_WORDS = [
  ['ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ПАО'], ['ПАО', 'ПАО'],
  ['НЕПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'НАО'], ['НАО', 'НАО'],
  ['ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ЗАО'], ['ЗАО', 'ЗАО'],
  ['АКЦИОНЕРНОЕ ОБЩЕСТВО', 'АО'], ['АО', 'АО'],
  ['ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ', 'ООО'], ['ООО', 'ООО'],
  ['ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ', 'ИП'], ['ИП', 'ИП'],
  ['КРЕСТЬЯНСКОЕ (ФЕРМЕРСКОЕ) ХОЗЯЙСТВО', 'КФХ'], ['КРЕСТЬЯНСКОЕ ХОЗЯЙСТВО', 'КФХ'], ['КХ', 'КФХ'],
  ['ПРОИЗВОДСТВЕННЫЙ КООПЕРАТИВ', 'ПК'], ['ПК', 'ПК'],
  ['ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ', 'ГУП'], ['ГУП', 'ГУП'],
  ['МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ', 'МУП'], ['МУП', 'МУП'],
  ['ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ', 'ФГУП'], ['ФГУП', 'ФГУП'],
];

class Failure extends Error {
  constructor(reason, detail) { super(detail); this.reason = reason; }
}

function normalize(s) {
  return String(s || '').toUpperCase().replace(/Ё/g, 'Е').replace(/["'«»“”„.,()\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

const FORMS = FORM_WORDS
  .map(([phrase, code]) => [normalize(phrase), code])
  .sort((a, b) => b[0].length - a[0].length);

/** Split a name into its legal form code (if any) and its core name, both normalised. */
function parseName(s) {
  let t = ' ' + normalize(s) + ' ';
  let form = '';
  for (const [phrase, code] of FORMS) {
    const p = ' ' + phrase + ' ';
    if (t.includes(p)) {
      form = form || code;
      t = t.split(p).join(' ');
    }
  }
  return { form, core: t.replace(/\s+/g, ' ').trim() };
}

/** A search row is the company when its full or short name has the same core and the same legal form (if both show one). */
function isSameCompany(keyword, row) {
  const want = parseName(keyword);
  if (!want.core) return false;
  return [row.n, row.c].some((name) => {
    if (!name) return false;
    const got = parseName(name);
    return got.core === want.core && (!got.form || !want.form || got.form === want.form);
  });
}

async function call(url, init, deadline) {
  const ms = deadline - Date.now();
  if (ms < 1000) throw new Failure('timeout', 'the check ran out of its time budget');
  let text;
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Referer': SITE + 'index.html', ...(init.headers || {}) },
      signal: AbortSignal.timeout(Math.min(25000, ms)),
    });
    if (res.status === 403 || res.status === 429) throw new Failure('blocked', `HTTP ${res.status}`);
    text = await res.text();
    if (/captchaSearch|captchaVyp|"captchaRequired"\s*:\s*true/.test(text)) {
      throw new Failure('blocked', `the site asks for a captcha: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Failure('http_error', `HTTP ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    if (e instanceof Failure) throw e;
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Failure('timeout', 'no answer from the site in time');
    throw new Failure('other', 'request failed: ' + String(e && e.message || e).slice(0, 200));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure('layout_changed', 'answer is not JSON: ' + text.slice(0, 200));
  }
}

/** One results page: POST the search, then poll the token until the rows arrive. */
async function searchPage(keyword, page, deadline) {
  const body = new URLSearchParams({ query: keyword, region: '', PreventChromeAutocomplete: '' });
  if (page > 1) body.set('page', String(page));
  const posted = await call(SITE, { method: 'POST', body, headers: { 'X-Requested-With': 'XMLHttpRequest' } }, deadline);
  if (posted.captchaRequired === true) throw new Failure('blocked', 'the site asks for a captcha before it searches');
  if (posted.errors) throw new Failure('other', 'the site refused the search: ' + JSON.stringify(posted.errors).slice(0, 200));
  if (!posted.t) throw new Failure('layout_changed', 'no search token in the answer');

  for (let i = 0; i < 12; i++) {
    const data = await call(SITE + 'search-result/' + encodeURIComponent(posted.t) + '?r=' + Date.now(), { method: 'GET' }, deadline);
    if (data && Array.isArray(data.rows)) return data.rows;
    if (!data || data.status !== 'wait') throw new Failure('layout_changed', 'search result has no rows: ' + JSON.stringify(data).slice(0, 200));
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Failure('timeout', 'the search result did not arrive in time');
}

function totalOf(rows) {
  const r = rows.find((x) => x && x.cnt !== undefined);
  return r ? Number(r.cnt) || 0 : 0;
}

function answer(status, reason, records, excerpt) {
  return { status, reason, records, source_url: SITE, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const kw = String(keyword || '').replace(/\s+/g, ' ').trim();
    if (!kw) return answer('couldnt_check', 'other', [], 'empty company name');

    // Read page 1; read more pages only while nothing matches (the site throttles bursts of searches).
    const pages = [];
    let total = 0;
    let matches = [];
    for (let p = 1; ; p++) {
      const rows = await searchPage(kw, p, deadline);
      pages.push(rows);
      if (p === 1) total = totalOf(rows);
      const named = rows.filter((r) => r && (r.n || r.c) && r.k !== 'fl'); // natural persons are not companies
      matches = matches.concat(named.filter((r) => isSameCompany(kw, r)));
      if (matches.length > 0 || p >= Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE))) break;
    }

    const rows = pages.flat().filter((r) => r && (r.n || r.c));

    if (matches.length > 0) {
      const records = matches.map((r) => ({
        name: r.n || '',
        short_name: r.c || '',
        inn: r.i || '',
        ogrn: r.o || '',
        kpp: r.p || '',
        kind: r.k || '',
        registration_date: r.r || '',
        termination_date: r.e || '',
        region: r.rn || '',
        head: r.g || '',
      }));
      return answer('found', '', records, `${matches.length} matching record(s); ${rows.length} of ${total} search results compared`);
    }

    if (rows.length >= total) {
      return answer('not_found', '', [], `no record with this name; the site returned ${total} result(s) for the search`);
    }
    return answer('couldnt_check', 'other', [],
      `exact name not in the first ${rows.length} of ${total} results; the rest were not checked`);
  } catch (err) {
    if (err instanceof Failure) return answer('couldnt_check', err.reason, [], err.message);
    return answer('couldnt_check', 'other', [], String(err && err.message || err));
  }
}
