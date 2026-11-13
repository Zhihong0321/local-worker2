export const meta = { task: 'AE-amazon.ae', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'seller_name', 'seller_id', 'storefront_url'],
  canary: { found: 'JOURNEY OF SCENT GENERAL TRADING L.L.C', not_found: 'شركة الصحراء الوهمية للتجارة ذ.م.م' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const MAX_SELLERS = 20;
const DEADLINE_MS = 40000;

// Legal-form words that are dropped before comparing names (LLC, L.L.C, FZE, FZ-LLC, ...).
const LEGAL = new Set(['llc', 'fze', 'fzc', 'fz', 'fzllc', 'llp', 'ltd', 'limited', 'pjsc', 'psc', 'sole', 'proprietorship']);

function norm(str) {
  const words = (str || '').normalize('NFKC').toLowerCase().replace(/\./g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.filter((w) => !LEGAL.has(w)).join('');
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

const CAPTCHA_MARKERS = ['Enter the characters you see below', 'Type the characters you see in this image', 'validateCaptcha', 'api-services-support@amazon.com'];

async function get(url, timeoutMs = 25000) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  const text = res.status === 200 ? await res.text() : '';
  return { status: res.status, text };
}

function isBlocked(status, text) {
  if ([202, 403, 429, 503].includes(status)) return true;
  return CAPTCHA_MARKERS.some((m) => text.includes(m));
}

/** Amazon's search returns 0 results for dotted legal forms ("L.L.C"), so the query is cleaned first. */
function cleanQuery(str) {
  return (str || '').normalize('NFKC').replace(/[.,]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function stripLegal(str) {
  return cleanQuery(str).split(' ').filter((w) => w && !LEGAL.has(w.toLowerCase())).join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const queries = [...new Set([cleanQuery(keyword), stripLegal(keyword)].filter(Boolean))];
  const searchUrls = queries.map((q) => `https://www.amazon.ae/s?k=${encodeURIComponent(q)}`);
  const sourceUrl = searchUrls[0];
  try {
    // Step 1: search. Try the name as written, then without the legal form if that finds nothing.
    const sellerIds = [];
    let emptyAnswers = 0;
    for (const searchUrl of searchUrls) {
      const search = await get(searchUrl);
      if (search.status !== 200 || isBlocked(search.status, search.text)) {
        const reason = isBlocked(search.status, search.text) ? 'blocked' : 'http_error';
        return { status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: `HTTP ${search.status}` };
      }
      const ids = [...search.text.matchAll(/merchantId"\s+value="([A-Z0-9]{8,20})"/g)].map((m) => m[1]);
      if (ids.length === 0) {
        if (search.text.includes('No results for')) { emptyAnswers++; continue; }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: search.text.slice(0, 300) };
      }
      sellerIds.push(...ids);
      if (sellerIds.length > 0 && searchUrl === searchUrls[0]) break; // first query had sellers; use them
    }
    const uniqueIds = [...new Set(sellerIds)];
    if (uniqueIds.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: `No results for the search (${emptyAnswers} queries)` };
    }

    // Step 2: visit each seller's storefront (the trade name is shown there, not in search results).
    const target = norm(keyword);
    const toCheck = uniqueIds.slice(0, MAX_SELLERS);
    const records = [];
    const problems = [];
    let next = 0;

    async function worker() {
      while (next < toCheck.length) {
        const id = toCheck[next++];
        if (Date.now() - started > DEADLINE_MS) { problems.push(`${id}: skipped, time limit`); continue; }
        const url = `https://www.amazon.ae/sp?seller=${id}`;
        try {
          const page = await get(url);
          if (page.status !== 200 || isBlocked(page.status, page.text)) { problems.push(`${id}: HTTP ${page.status}`); continue; }
          const bn = page.text.match(/Business Name:\s*<\/span>\s*<span>([^<]+)<\/span>/);
          if (!bn) continue;
          const businessName = decodeEntities(bn[1]);
          if (target && norm(businessName) === target) {
            const sn = page.text.match(/id="seller-name"[^>]*>([^<]+)</);
            records.push({ name: businessName, seller_name: sn ? decodeEntities(sn[1]) : '', seller_id: id, storefront_url: url });
          }
        } catch (e) {
          problems.push(`${id}: ${String(e?.message || e).slice(0, 80)}`);
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: sourceUrl, excerpt: `Seller storefront business name matched: ${records[0].name}` };
    }
    if (problems.length > 0 || uniqueIds.length > MAX_SELLERS) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
        excerpt: `No match among ${toCheck.length} of ${uniqueIds.length} sellers; not all storefronts could be read: ${problems.slice(0, 5).join('; ')}` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
      excerpt: `Search answered; none of the ${toCheck.length} sellers in the results has this business name` };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
