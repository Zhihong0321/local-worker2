export const meta = {
  task: 'TH-lazada.co.th',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'seller_id', 'sample_product_url', 'total_results'],
  canary: { found: 'SUPERPART', not_found: 'บริษัท ซยฟกสนรผ จำกัด' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words (Thai and English). Removed before comparing, because Lazada seller names carry no legal form.
const LEGAL_FORMS = /บริษัท|จำกัด|\(?มหาชน\)?|ห้างหุ้นส่วน|หจก\.?|\b(co|ltd|limited|company|pte|sdn|bhd|plc|inc|corp|corporation|llc)\b/g;

/** Lower-case, drop legal forms, keep only letters and digits (Latin and Thai). */
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(LEGAL_FORMS, ' ')
    .replace(/[^a-z0-9฀-๿]/g, '');
}

// On Windows with Node 24, process.exit() right after a fetch can trip a libuv assertion (exit code 127) even though
// the answer was already printed. A short pause lets the connection close first. It does not change the answer.
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await lookupOnce(keyword);
  await settle();
  return out;
}

async function lookupOnce(keyword) {
  const text = String(keyword || '').trim();
  const stripped = text.toLowerCase().replace(LEGAL_FORMS, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const query = stripped || text;
  const searchUrl = `https://www.lazada.co.th/catalog/?ajax=true&q=${encodeURIComponent(query)}`;
  const pageUrl = `https://www.lazada.co.th/catalog/?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'th,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
    }

    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      // Not JSON: a bot check page, or the search layout has changed.
      const looksBlocked = /captcha|baxia|punish|x5secdata|slide to verify/i.test(body.slice(0, 5000));
      return {
        status: 'couldnt_check',
        reason: looksBlocked ? 'blocked' : 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: body.slice(0, 300),
      };
    }

    const items = json?.mods?.listItems;
    if (!Array.isArray(items)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: body.slice(0, 300) };
    }

    const total = json?.mods?.resultTips?.tips || json?.mainInfo?.totalResults || '';
    const target = normalize(text);
    const sellers = new Map();

    if (target) {
      for (const it of items) {
        if (!it || !it.sellerId || !it.sellerName) continue;
        if (normalize(it.sellerName) !== target) continue;
        if (!sellers.has(String(it.sellerId))) {
          const url = it.itemUrl ? new URL(it.itemUrl, 'https://www.lazada.co.th').href : '';
          sellers.set(String(it.sellerId), { name: String(it.sellerName), seller_id: String(it.sellerId), sample_product_url: url, total_results: String(total) });
        }
      }
    }

    if (sellers.size === 0) {
      // The site answered normally; no seller with this name is among the search results.
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: `No seller named "${text}" in ${items.length} search results (${total})`,
      };
    }

    const records = [...sellers.values()];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt: `${records.length} seller(s) named "${records[0].name}" (${total})`,
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: pageUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
