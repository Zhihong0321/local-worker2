export const meta = {
  task: 'TH-thaitrade.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'seller_code', 'profile_url', 'total_products'],
  canary: { found: 'A.K International Trading Co., Ltd', not_found: 'บริษัท ซีแซดเอ็กซ์ ควอนตัม จำกัด' },
};

const SITE = 'https://www.thaitrade.com';
const SEARCH_API = 'https://www.thaitrade.com/api/b2c/search/all';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;          // first query variant only; 20 suppliers per page
const DEADLINE_MS = 30000;    // no new request after 30 s, so the whole call ends well under 60 s

// Legal forms, English and Thai, removed before comparing names.
const LEGAL_FORMS = new Set(['co', 'ltd', 'limited', 'company', 'pcl', 'public', 'plc', 'bhd', 'sdn', 'inc', 'corp',
  'corporation', 'llc', 'llp', 'partnership', 'part', 'parnership', 'lp', 'gmbh', 'pte']);
const THAI_FORMS_RE = /บริษัท|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วน|จำกัด|มหาชน|หจก|บจก|บมจ/g;
const END_FORM_RE = /(?:[\s,.]*\b(?:co|ltd|limited|company|pcl|public|plc|bhd|sdn|inc|corp|corporation|llc|llp|partnership|part|parnership|lp)\b\.?)+[\s,.]*$/i;

/** Normalised name: lower case, punctuation and spaces dropped, legal form dropped. */
function normKey(name) {
  let s = String(name || '').toLowerCase().replace(THAI_FORMS_RE, ' ');
  s = s.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  return s.split(' ').filter((t) => t && !LEGAL_FORMS.has(t)).join('');
}

/** Query variants: as typed, without the trailing legal form, and without dots and commas (the site search is punctuation-sensitive). */
function variants(keyword) {
  const typed = keyword.replace(/\s+/g, ' ').trim();
  let stripped = typed.replace(END_FORM_RE, '').trim();
  if (!stripped) stripped = typed;
  const noPunct = stripped.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...new Set([typed, stripped, noPunct].filter(Boolean))].slice(0, 3);
}

function searchPageUrl(q) {
  return `${SITE}/search?q=${encodeURIComponent(q)}&type=supplier`;
}

async function postSearch(query, page) {
  let res;
  try {
    res = await fetch(SEARCH_API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': SITE,
        'Referer': searchPageUrl(query),
      },
      body: JSON.stringify({ keyword_search: query, page, last_key: '', current_lang: 'en' }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: { reason: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) } };
  }
  if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const walled = /captcha|challenge|cf-chl|access denied/i.test(text);
    return { fail: { reason: walled ? 'blocked' : 'layout_changed', excerpt: text.slice(0, 200) } };
  }
  const d = json?.data;
  if (!d || !Array.isArray(d.sellers)) return { fail: { reason: 'layout_changed', excerpt: text.slice(0, 200) } };
  return { sellers: d.sellers, total: Number(d.total) || 0, more: d.is_load_more === true };
}

function pickName(shopName) {
  if (!shopName || typeof shopName !== 'object') return String(shopName || '');
  return shopName.en || shopName.EN || Object.values(shopName).find((v) => typeof v === 'string' && v) || '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty company name' };
    }
    const key = normKey(kw);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'name has no letters or digits to compare' };
    }

    const qs = variants(kw);
    let totalSeen = 0;
    for (let vi = 0; vi < qs.length; vi++) {
      const q = qs[vi];
      const maxPages = vi === 0 ? MAX_PAGES : 1;
      for (let page = 1; page <= maxPages; page++) {
        if (Date.now() - started > DEADLINE_MS) {
          return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchPageUrl(q), excerpt: 'stopped before 60 s' };
        }
        const r = await postSearch(q, page);
        if (r.fail) {
          return { status: 'couldnt_check', reason: r.fail.reason, records: [], source_url: searchPageUrl(q), excerpt: r.fail.excerpt };
        }
        if (vi === 0 && page === 1) totalSeen = r.total;

        const hits = r.sellers.filter((s) => {
          const names = s.shop_name && typeof s.shop_name === 'object' ? Object.values(s.shop_name) : [s.shop_name];
          return names.some((n) => typeof n === 'string' && normKey(n) === key);
        });
        if (hits.length) {
          return {
            status: 'found',
            reason: '',
            records: hits.map((s) => ({
              name: pickName(s.shop_name),
              seller_code: s.seller_code || '',
              profile_url: s.shop_url ? `${SITE}${s.shop_url}` : '',
              total_products: s.shop_total_product ?? null,
            })),
            source_url: searchPageUrl(q),
            excerpt: `Supplier search "${q}" returned ${r.total} result(s); exact name match: ${pickName(hits[0].shop_name)}`,
          };
        }
        if (!r.more || r.sellers.length === 0) break;
      }
    }

    const thaiNote = /[฀-๿]/.test(kw)
      ? ' The site search matches English names only, so a Thai-script query cannot match.'
      : '';
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchPageUrl(qs[0]),
      excerpt: `Supplier search for ${qs.map((q) => `"${q}"`).join(', ')} returned no supplier with this name (first query: ${totalSeen} result(s)).${thaiNote}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SITE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
