export const meta = {
  task: 'TW-momoshop.com.tw', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['shop_name', 'entp_code', 'sample_goods_name', 'sample_goods_url'],
  canary: { found: '南慶五金商行', not_found: '甘蔗塔斯特亞洲虛構科技股份有限公司' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const BASE = 'https://www.momoshop.com.tw';

// Legal forms that are removed before comparing names (Taiwan and common English forms).
const LEGAL_FORMS = [
  /股份有限公司/g, /有限公司/g, /有限責任公司/g, /股份有限/g,
  /\bpte\.?\s*ltd\.?/gi, /\bsdn\.?\s*bhd\.?/gi, /\bco\.?\s*,?\s*ltd\.?/gi,
  /\bltd\.?/gi, /\blimited\b/gi, /\binc\.?/gi, /\bcorp(oration)?\.?/gi, /\bcompany\b/gi, /\bllc\b/gi, /\bgmbh\b/gi,
];

/** Normalised name: NFKC, traditional 臺 -> 台, legal form removed, only letters and digits kept, lower case. */
function core(s) {
  let x = String(s || '').normalize('NFKC').replace(/臺/g, '台');
  for (const re of LEGAL_FORMS) x = x.replace(re, ' ');
  return x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The keyword as sent to the site's search box: the name without its legal form. */
function searchTerm(keyword) {
  let x = String(keyword || '').normalize('NFKC').replace(/臺/g, '台');
  for (const re of LEGAL_FORMS) x = x.replace(re, ' ');
  return x.replace(/\s+/g, ' ').trim() || String(keyword || '').trim();
}

function field(chunk, name) {
  const m = chunk.match(new RegExp('"' + name + '":"\\s*([^"]*)"'));
  return m ? m[1].trim() : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let out = await lookupOnce(keyword);
  // The site sometimes answers with a degraded page that has no seller list. Call it not_found only when
  // a second request says the same; if the second request differs, report what it returned.
  if (out.status === 'not_found') {
    out = await lookupOnce(keyword);
    if (out.status === 'not_found') out = { ...out, excerpt: 'confirmed by a second request: ' + out.excerpt };
  }
  // Give the HTTP socket a moment to close before the runner exits; without it Node 24 on Windows
  // aborts with a libuv assertion (exit 127) after the answer is already printed.
  await new Promise((r) => setTimeout(r, 500));
  return out;
}

async function lookupOnce(keyword) {
  const term = searchTerm(keyword);
  const searchUrl = `${BASE}/search/${encodeURIComponent(term)}?viewport=desktop`;
  try {
    const res = await fetch(searchUrl, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const raw = await res.text();
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (/Access Denied/i.test(raw) && !/totCnt/.test(raw)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'Access Denied page' };
    }

    // The results are JSON embedded in the page; quotes inside it are escaped as \".
    const text = raw.replace(/\\"/g, '"');
    const totMatch = text.match(/"totCnt":\s*(\d+)/);
    if (!totMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }
    const total = Number(totMatch[1]);

    // Each product item starts with "goodsCode"; its seller fields belong to the same chunk.
    const target = core(keyword);
    const byShop = new Map();
    let sellersSeen = 0;
    for (const chunk of text.split('"goodsCode"').slice(1)) {
      const shopName = field(chunk, 'shopName');
      if (!shopName) continue;
      sellersSeen++;
      if (!target || core(shopName) !== target) continue;
      const key = shopName + '|' + field(chunk, 'entpCode');
      if (!byShop.has(key)) {
        byShop.set(key, {
          shop_name: shopName,
          entp_code: field(chunk, 'entpCode'),
          sample_goods_name: field(chunk, 'goodsName'),
          sample_goods_url: field(chunk, 'goodsUrl'),
        });
      }
    }

    const records = [...byShop.values()].slice(0, 10);
    if (records.length > 0) {
      return {
        status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: `${records.length} seller(s) named "${records[0].shop_name}"; product results for the search: ${total}`,
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `search "${term}": ${total} results, ${sellersSeen} seller names shown, none matches "${keyword}"`,
    };
  } catch (e) {
    const name = String(e && e.name || '');
    const reason = /Timeout|Abort/i.test(name) ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(e).slice(0, 300) };
  }
}
