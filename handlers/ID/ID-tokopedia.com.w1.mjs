export const meta = { task: 'ID-tokopedia.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'shop_url', 'domain', 'is_official', 'is_pm_pro', 'location', 'shop_status'],
  canary: { found: 'PT. Unilever', not_found: 'PT Gorengan Pisang Tidak Terdaftar' } };

// The same GraphQL query the Tokopedia shop-search page sends (AceSearchShopQuery), copied from the page's own bundle.
const QUERY = 'query AceSearchShopQuery($params:String!){aceSearchShop(params:$params){shops{old_shop_id:shop_id shop_id:shop_id_str_auto_ shop_name shop_domain shop_is_owner shop_location shop_status shop_tag_line shop_description reputation_score shop_total_favorite shop_gold_shop is_pm_pro is_official shop_url shop_image reputation_image_uri shop_lucky products{old_id:id id:id_str_auto_ name url price image_url price_format __typename}ga_key favorited voucher{free_shipping cashback{cashback_value is_percentage __typename}__typename}__typename}suggestion{currentKeyword text query}header{keyword_process response_code total_data}__typename}}';

const GQL_URL = 'https://gql.tokopedia.com/graphql/AceSearchShopQuery';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['pt', 'cv', 'tbk', 'ud', 'pd', 'persero', 'perseroan', 'terbatas']);
const BUDGET_MS = 55000;

function tokens(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Company core for comparison: lower case, no punctuation, no legal form (PT, CV, Tbk ...). */
function core(s) {
  const t = tokens(s);
  const kept = t.filter((x) => !LEGAL.has(x));
  return (kept.length ? kept : t).join('');
}

/** The keyword without its legal-form words, as the user typed the rest (used for a second search). */
function coreQuery(keyword) {
  const words = (keyword || '').trim().split(/\s+/).filter((w) => !LEGAL.has(tokens(w).join('')));
  return words.join(' ').trim();
}

function searchUrl(keyword) {
  return `https://www.tokopedia.com/search?st=shop&q=${encodeURIComponent(keyword)}`;
}

/** One GraphQL search. Returns { ok: true, shops, total } or { ok: false, status, reason, excerpt }. */
async function search(keyword, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1000) return { ok: false, status: 0, reason: 'timeout', excerpt: 'no time left for the search' };
  const params = `navsource=&q=${encodeURIComponent(keyword)}&source=search_shop&st=shop&user_addressId=&user_cityId=176&user_districtId=2274&user_lat=&user_long=&rows=50&start=0`;
  let res;
  try {
    res = await fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': 'https://www.tokopedia.com',
        'Referer': searchUrl(keyword),
      },
      body: JSON.stringify({ operationName: 'AceSearchShopQuery', query: QUERY, variables: { params } }),
      signal: AbortSignal.timeout(Math.min(25000, remaining)),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, status: 0, reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }

  const text = await res.text();
  if (res.status === 403 || res.status === 429) {
    return { ok: false, status: res.status, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, reason: 'http_error', excerpt: `HTTP ${res.status} ${text.slice(0, 200)}` };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const low = text.toLowerCase();
    const blocked = /captcha|access denied|challenge|verify you are human/.test(low);
    return { ok: false, status: res.status, reason: blocked ? 'blocked' : 'layout_changed', excerpt: text.slice(0, 300) };
  }

  const data = json?.data?.aceSearchShop;
  if (!data || !Array.isArray(data.shops)) {
    const msg = json?.errors?.[0]?.message;
    return { ok: false, status: res.status, reason: msg ? 'other' : 'layout_changed', excerpt: (msg || text).slice(0, 300) };
  }
  return { ok: true, shops: data.shops, total: Number(data.header?.total_data ?? data.shops.length) };
}

function toRecord(s) {
  return {
    name: s.shop_name || '',
    shop_url: s.shop_url || (s.shop_domain ? `https://www.tokopedia.com/${s.shop_domain}` : ''),
    domain: s.shop_domain || '',
    is_official: s.is_official === true,
    is_pm_pro: s.is_pm_pro === true,
    location: s.shop_location || '',
    shop_status: s.shop_status ?? null,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + BUDGET_MS;
  const src = searchUrl(keyword);
  try {
    const want = core(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: src, excerpt: 'the name has no company words to search' };
    }

    // Pass 1: the name as typed. Pass 2 (only if different): the name without the legal form.
    const passes = [keyword];
    const cq = coreQuery(keyword);
    if (cq && cq !== keyword.trim()) passes.push(cq);

    let seen = [];
    let anyTotal = 0;
    for (const q of passes) {
      const r = await search(q, deadline);
      if (!r.ok) {
        return { status: 'couldnt_check', reason: r.reason, records: [], source_url: src, excerpt: r.excerpt };
      }
      anyTotal = Math.max(anyTotal, r.total);
      seen = seen.concat(r.shops);
      const matches = r.shops.filter((s) => core(s.shop_name) === want);
      if (matches.length) {
        const unique = [];
        const keys = new Set();
        for (const m of matches) {
          const key = `${m.shop_domain}`;
          if (!keys.has(key)) { keys.add(key); unique.push(toRecord(m)); }
        }
        return {
          status: 'found',
          reason: '',
          records: unique,
          source_url: src,
          excerpt: `Tokopedia shop search: ${unique.length} shop(s) named like "${keyword}": ` +
            unique.map((u) => `${u.name}${u.is_official ? ' [Official Store]' : ''}${u.is_pm_pro ? ' [PM Pro]' : ''}`).join('; ').slice(0, 400),
        };
      }
    }

    // The site answered normally and no shop has this name.
    const closest = [...new Set(seen.map((s) => s.shop_name))].slice(0, 5).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: src,
      excerpt: anyTotal === 0
        ? `Tokopedia shop search: 0 results for "${keyword}"`
        : `Tokopedia shop search: ${anyTotal} result(s) for "${keyword}", none with this exact name. Closest: ${closest}`.slice(0, 400),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: src,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
