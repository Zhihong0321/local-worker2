export const meta = { task: 'JP-jab.or.jp', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'en_name', 'registration_no', 'certificate_no', 'certification_body', 'standard', 'ms_type', 'location',
    'en_location', 'postal_code', 'office_name', 'scope', 'first_registered', 'recertified', 'expiry', 'cancelled',
    'publish_status', 'id'],
  canary: { found: '東北プレス工業 株式会社', not_found: '架空商事株式会社' } };

// JAB's public "MS Certified Organizations" search (https://www.jab.or.jp/compatible_organizations) reads this JSON API.
const API = 'https://www.jab.or.jp/cms/api/compatible-organizations';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;          // up to 500 hits are read; more than that is couldnt_check, not not_found
const MAX_DETAIL = 10;        // detail records fetched per company
const START_LIMIT_MS = 33000; // no new request after 33 s, so the last 25 s fetch ends before 60 s

class CouldntCheck extends Error {
  constructor(reason, excerpt, url) { super(reason); this.reason = reason; this.excerpt = excerpt; this.url = url; }
}

// Removes Japanese and English legal forms (株式会社, (株), ㈱, Co., Ltd., Inc., ...) for comparing names.
function stripLegal(s) {
  return String(s || '').normalize('NFKC')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|\(株\)|\(有\)|\(同\)/g, ' ')
    .replace(/\b(co|ltd|inc|corp|corporation|company|limited|llc|pte|sdn|bhd)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Normalised name: case, punctuation, spaces and legal form ignored.
function norm(s) {
  return stripLegal(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function searchUrl(term, page) {
  const p = new URLSearchParams();
  p.set('filters[keyword]', term);
  p.set('sort', 'id:asc');
  p.set('pagination[page]', String(page));
  p.set('pagination[pageSize]', String(PAGE_SIZE));
  p.set('locale', 'ja');
  return `${API}?${p.toString()}`;
}

async function getJson(url, t0) {
  if (Date.now() - t0 > START_LIMIT_MS) throw new CouldntCheck('timeout', 'time budget used up before ' + url, url);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new CouldntCheck(timedOut ? 'timeout' : 'other', String(e?.message || e), url);
  }
  if (res.status === 403 || res.status === 429) throw new CouldntCheck('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw new CouldntCheck('http_error', `HTTP ${res.status}`, url);
  const text = await res.text();
  if (/captcha|cf-chl|access denied/i.test(text.slice(0, 3000))) throw new CouldntCheck('blocked', 'bot check page', url);
  try {
    return JSON.parse(text);
  } catch {
    throw new CouldntCheck('layout_changed', 'response is not JSON: ' + text.slice(0, 200), url);
  }
}

// Reads every hit of one search term (up to MAX_PAGES pages).
async function searchAll(term, t0) {
  const all = [];
  let total = 0;
  let firstUrl = '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = searchUrl(term, page);
    if (!firstUrl) firstUrl = url;
    const json = await getJson(url, t0);
    if (!Array.isArray(json?.data) || !json?.meta?.pagination) {
      throw new CouldntCheck('layout_changed', 'unexpected search response shape', url);
    }
    total = Number(json.meta.pagination.total);
    all.push(...json.data);
    if (json.data.length < PAGE_SIZE || all.length >= total) break;
    if (page === MAX_PAGES) {
      throw new CouldntCheck('other', `too many hits for "${term}" (${total}); the name needs to be more specific`, firstUrl);
    }
  }
  return { hits: all, total, firstUrl };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const kw = String(keyword || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  try {
    if (!norm(kw)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    // The site writes names with a space before 株式会社 and matches substrings, so search the core name.
    const core = stripLegal(kw).replace(/^[\s.,()\-]+|[\s.,()\-]+$/g, '') || kw;
    const want = norm(kw);
    const terms = [core];
    if (core.includes(' ') && core.split(' ')[0].length >= 3) terms.push(core.split(' ')[0]); // English fallback

    let matches = [];
    let firstUrl = '';
    let similar = null; // first search that had hits but no exact name
    for (const term of terms) {
      const r = await searchAll(term, t0);
      if (!firstUrl) firstUrl = r.firstUrl;
      const m = r.hits.filter(h => norm(h.attributes?.name) === want || norm(h.attributes?.en_name) === want);
      if (m.length) { matches = m; break; }
      if (r.total > 0 && !similar) similar = r;
    }
    if (matches.length === 0) {
      // The search reads the name field, which is Japanese for most companies. An English-only name can be
      // listed under its Japanese name, so "no match" here does not prove the company is absent.
      if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(kw)) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
          excerpt: `English-only name "${kw}": no record with this English name; the site's search reads the Japanese name field, so absence cannot be shown` };
      }
      if (!similar) {
        return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
          excerpt: `JAB MS certified organizations: 0 results for "${core}"` };
      }
      const closest = similar.hits.slice(0, 5).map(h => h.attributes?.name).join(' | ');
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `${similar.total} similar result(s), none with the same normalised name as "${kw}". Closest: ${closest}`.slice(0, 500) };
    }

    const records = [];
    for (const m of matches.slice(0, MAX_DETAIL)) {
      const a = m.attributes || {};
      let d = {};
      try {
        const j = await getJson(`${API}/${m.id}?locale=ja`, t0);
        d = j?.data?.attributes || {};
      } catch (e) {
        if (!(e instanceof CouldntCheck)) throw e;
        // detail page failed: keep what the search row shows
      }
      records.push({
        name: d.name || a.name || '',
        en_name: d.en_name || a.en_name || '',
        registration_no: d.regis_num || '',
        certificate_no: d.cert_num || '',
        certification_body: a.abbr || '',
        standard: a.cert_standard_code || '',
        ms_type: a.ms_type_code || '',
        location: d.location || a.location || '',
        en_location: d.en_location || a.en_location || '',
        postal_code: d.postal_code || '',
        office_name: d.office_name || a.office_name || '',
        scope: d.regis_scope || '',
        first_registered: d.init_regis_date || '',
        recertified: d.recert_date || '',
        expiry: d.exp_date || '',
        cancelled: d.regis_cancel_date || '',
        publish_status: d.publish_status || '',
        id: m.id,
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstUrl,
      excerpt: `${records.length} record(s) for "${kw}": ` +
        records.map(r => `${r.name} | ${r.certification_body} | ${r.standard} | expiry ${r.expiry || '-'}`).join('; ').slice(0, 400),
    };
  } catch (err) {
    if (err instanceof CouldntCheck) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url || '',
        excerpt: String(err.excerpt || '').slice(0, 500) };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: API,
      excerpt: String(err?.message || err).slice(0, 500) };
  }
}
