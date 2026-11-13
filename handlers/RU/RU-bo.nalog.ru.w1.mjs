export const meta = { task: 'RU-bo.nalog.ru', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'inn', 'ogrn', 'status', 'status_date', 'region', 'city', 'street', 'house', 'okved2'],
  canary: { found: 'ООО "СБЕРБАНК-СЕРВИС"', not_found: 'ЗЖЩФЫВАПРОЛДЖЭ ТЕСТОВАЯ НЕСУЩЕСТВУЮЩАЯ' } };

const BASE = 'https://bo.nalog.gov.ru';
const SEARCH_PATH = '/advanced-search/organizations/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;

// Russian legal forms: [words, canonical form]. Long phrases first. ЗАО, ОАО, НАО and АО are all joint-stock
// companies (after the 2014 reform they are one legal form), so they share the canonical form 'АО'.
const LEGAL_FORMS = [
  [['ОБЩЕСТВО', 'С', 'ОГРАНИЧЕННОЙ', 'ОТВЕТСТВЕННОСТЬЮ'], 'ООО'],
  [['ПУБЛИЧНОЕ', 'АКЦИОНЕРНОЕ', 'ОБЩЕСТВО'], 'ПАО'],
  [['ПУБЛИЧНОЕ', 'АО'], 'ПАО'],
  [['НЕПУБЛИЧНОЕ', 'АКЦИОНЕРНОЕ', 'ОБЩЕСТВО'], 'АО'],
  [['НЕПУБЛИЧНОЕ', 'АО'], 'АО'],
  [['ЗАКРЫТОЕ', 'АКЦИОНЕРНОЕ', 'ОБЩЕСТВО'], 'АО'],
  [['ЗАКРЫТОЕ', 'АО'], 'АО'],
  [['ОТКРЫТОЕ', 'АКЦИОНЕРНОЕ', 'ОБЩЕСТВО'], 'АО'],
  [['ОТКРЫТОЕ', 'АО'], 'АО'],
  [['АКЦИОНЕРНОЕ', 'ОБЩЕСТВО'], 'АО'],
  [['ИНДИВИДУАЛЬНЫЙ', 'ПРЕДПРИНИМАТЕЛЬ'], 'ИП'],
  [['ООО'], 'ООО'], [['ПАО'], 'ПАО'], [['АО'], 'АО'], [['ЗАО'], 'АО'], [['ОАО'], 'АО'], [['НАО'], 'АО'],
  [['ИП'], 'ИП'], [['ГУП'], 'ГУП'], [['МУП'], 'МУП'], [['ФГУП'], 'ФГУП'], [['АНО'], 'АНО'], [['ОБЩЕСТВО'], 'ОБЩЕСТВО'],
].sort((a, b) => b[0].length - a[0].length);

/** Upper case, ё -> е, every other symbol becomes a space, words separated by single spaces. */
function norm(s) {
  return String(s || '').toUpperCase().replace(/Ё/g, 'Е').replace(/[^A-ZА-Я0-9]+/g, ' ').trim();
}

/** The legal form starting at word i of w: [words used, canonical form], or null. */
function legalAt(w, i) {
  for (const [p, canon] of LEGAL_FORMS) {
    if (p.every((x, k) => w[i + k] === x)) return [p.length, canon];
  }
  return null;
}

/** The name without its legal form, as words joined by single spaces ('' when nothing is left). */
function coreOf(s) {
  const w = norm(s).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < w.length;) {
    const hit = legalAt(w, i);
    if (hit) { i += hit[0]; continue; }
    out.push(w[i]);
    i++;
  }
  return out.join(' ');
}

/** The canonical legal form at the start of the name ('' when the name has none there). */
function legalOf(s) {
  const w = norm(s).split(' ').filter(Boolean);
  const hit = legalAt(w, 0);
  return hit ? hit[1] : '';
}

/** Comparison key: the core name with no spaces (or the whole normalised name if the core is empty). */
function keyOf(s) {
  return (coreOf(s) || norm(s)).replace(/ /g, '');
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One search request. Returns { data, url } or { err, url, excerpt }. */
async function getSearch(query) {
  const url = `${BASE}${SEARCH_PATH}?query=${encodeURIComponent(query)}&page=0&size=${PAGE_SIZE}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { err: timedOut ? 'timeout' : 'other', url, excerpt: String(e?.message || e).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { err: 'blocked', url, excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { err: 'http_error', url, excerpt: `HTTP ${res.status}` };

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    return { err: /captcha|robot|bot check/i.test(text) ? 'blocked' : 'layout_changed', url, excerpt: text.slice(0, 200) };
  }
  if (!data || !Array.isArray(data.content) || typeof data.totalElements !== 'number') {
    return { err: 'layout_changed', url, excerpt: text.slice(0, 200) };
  }
  return { data, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const firstUrl = `${BASE}${SEARCH_PATH}?query=${encodeURIComponent(input)}&page=0&size=${PAGE_SIZE}`;
  try {
    if (!norm(input)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty keyword' };
    }

    // The site search is loose (any shared word matches), so ask with the name as typed and, if it has
    // a legal form, with the bare name too. A match must have the same name once the legal form is ignored.
    const key = keyOf(input);
    const keyLegal = legalOf(input);
    const queries = [input];
    const core = coreOf(input);
    if (core && core !== norm(input)) queries.push(core);

    const records = [];
    const seen = new Set();
    let total = 0;
    let scanned = 0;
    for (const q of queries) {
      const r = await getSearch(q);
      if (r.err) {
        return { status: 'couldnt_check', reason: r.err, records: [], source_url: r.url, excerpt: r.excerpt };
      }
      total = Math.max(total, r.data.totalElements);
      scanned += r.data.content.length;
      for (const x of r.data.content) {
        if (!x || typeof x !== 'object') continue;
        const name = stripTags(x.shortName);
        // Same name once case, punctuation and legal form are normalised. A keyword without a legal form matches any form.
        if (!name || keyOf(name) !== key || (keyLegal && legalOf(name) !== keyLegal)) continue;
        const id = String(x.inn || x.ogrn || x.id || name);
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({
          name,
          inn: x.inn || '',
          ogrn: x.ogrn || '',
          status: x.statusCode || '',
          status_date: x.statusDate || '',
          region: x.region || '',
          city: x.city || '',
          street: x.street || '',
          house: [x.house, x.building, x.office].filter(Boolean).join(' '),
          okved2: x.okved2 || '',
        });
      }
    }

    if (records.length) {
      const r0 = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${records.length} exact name match(es): ${r0.name} | INN ${r0.inn} | status ${r0.status}`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 exact name matches for "${input}" among the top ${scanned} results (site total ${total})`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
