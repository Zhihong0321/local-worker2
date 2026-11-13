export const meta = {
  task: 'PH-lazada.com.ph',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'store_url', 'shop_id'],
  canary: { found: 'Power Mac Center', not_found: 'Kompanyang Walang Pangalan Trading Inc' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en',
};
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'opc', 'plc', 'pte', 'sdn', 'bhd', 'gmbh']);
const BLOCK_MARK = /captcha|punish|x5secdata|_____tmd_____|unusual traffic/i;

function out(status, reason, source_url, excerpt, records) {
  return { status, reason, records: records || [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Lower-case words of a name, accents removed, punctuation dropped, legal-form words at the end removed. */
function words(name) {
  return (name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
function withoutLegalForm(name) {
  const w = words(name);
  while (w.length > 1 && LEGAL_FORMS.has(w[w.length - 1])) w.pop();
  return w;
}
/** Comparison key: the name without spaces, punctuation, case or legal form. */
function nameKey(name) {
  return withoutLegalForm(name).join('');
}
/** Lazada store address slug: "Power Mac Center Inc." -> "power-mac-center". */
function slugFor(keyword) {
  return withoutLegalForm(keyword).join('-');
}
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
}
/** Store name as the store page's <title> writes it: "Power Mac Center  Philippines Official Online Store | ..." */
function storeName(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  let t = decode(m[1]).replace(/\s+/g, ' ').split('|')[0].trim();
  t = t.replace(/\s+Philippines\b[\s\S]*$/i, '').replace(/\s+Official Online Store\b[\s\S]*$/i, '').trim();
  return t;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const slug = slugFor(keyword);
  const url = `https://www.lazada.com.ph/shop/${slug}`;
  try {
    if (!slug) {
      return out('couldnt_check', 'other', url, 'the name has no Latin letters, so no Lazada store address can be built from it');
    }

    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const finalUrl = res.url || url;

    if (res.status === 403 || res.status === 429) {
      return out('couldnt_check', 'blocked', finalUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return out('couldnt_check', 'http_error', finalUrl, `HTTP ${res.status}`);
    }
    if (/shop-enter-fail-page/i.test(finalUrl)) {
      // The site answered normally: it has no store at this address.
      return out('not_found', '', finalUrl, `No Lazada store at /shop/${slug} ("Shop Enter Fail Page")`);
    }
    if (/invalidSellerStatus/i.test(finalUrl)) {
      // The site answered normally: the address has no active store.
      return out('not_found', '', finalUrl, `No active Lazada store at /shop/${slug} ("invalidSellerStatus")`);
    }
    if (/\/(login|signin|member)\b/i.test(finalUrl)) {
      return out('couldnt_check', 'blocked', finalUrl, 'redirected to a login page');
    }

    const html = await res.text();
    const name = storeName(html);
    if (!name) {
      if (BLOCK_MARK.test(html)) return out('couldnt_check', 'blocked', finalUrl, 'bot check page');
      return out('couldnt_check', 'layout_changed', finalUrl, html.replace(/\s+/g, ' ').slice(0, 300));
    }

    // The slug can land on a different store (the site redirects some slugs). Only an exact name match counts.
    if (nameKey(name) !== nameKey(keyword)) {
      return out('not_found', '', finalUrl, `Store at this address is "${name}", not the company`);
    }

    const storeUrl = finalUrl.split('?')[0];
    const shopId = (html.match(/shopId=(\d+)/) || [])[1] || '';
    return out('found', '', finalUrl, `Lazada store "${name}" at ${storeUrl}`, [
      { name, store_url: storeUrl, shop_id: shopId },
    ]);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timedOut ? 'timeout' : 'other', url, String((err && err.message) || err));
  }
}
