export const meta = { task: 'US-wellfound.com', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'slug', 'high_concept', 'company_size', 'company_url', 'locations', 'markets', 'total_raised_amount', 'hiring', 'page_url'],
  canary: { found: 'Stripe', not_found: 'Zqxvkwjneco Holdings' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://wellfound.com';
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'pbc', 'plc', 'pllc', 'pc']);

/** Lower-case words, dots removed ("L.L.C." -> "llc"), punctuation split. */
function words(str) {
  return (str || '').replace(/\./g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** Drop trailing legal-form words, but never the whole name. */
function stripLegal(ws) {
  const out = ws.slice();
  while (out.length > 1 && LEGAL.has(out[out.length - 1])) out.pop();
  return out;
}

/** Comparison key: normalised words without legal form. "Stripe, Inc." and "Stripe" give the same key. */
function nameKey(str) {
  return stripLegal(words(str)).join('');
}

function result(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let pageUrl = BASE;
  try {
    const ws = stripLegal(words(keyword));
    if (ws.length === 0) {
      return result('couldnt_check', 'other', [], BASE, 'no letters or digits in the company name');
    }
    const slug = ws.join('-');
    pageUrl = `${BASE}/company/${encodeURIComponent(slug)}`;

    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();

    // Bot wall: Cloudflare challenge or a "Security Check" page. Never a not_found.
    if (res.status === 403 || res.status === 429 || res.headers.get('cf-mitigated') === 'challenge' || /<title>Security Check/i.test(html.slice(0, 5000))) {
      return result('couldnt_check', 'blocked', [], pageUrl, `HTTP ${res.status}, bot check`);
    }
    // The site's own 404 page: no company is published at this address.
    if (res.status === 404) {
      return result('not_found', '', [], pageUrl, `no Wellfound company page at /company/${slug} (HTTP 404)`);
    }
    if (!res.ok) {
      return result('couldnt_check', 'http_error', [], pageUrl, `HTTP ${res.status}`);
    }

    // Company pages are server-rendered Next.js pages; the data is in __NEXT_DATA__.
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      return result('couldnt_check', 'layout_changed', [], pageUrl, html.slice(0, 300));
    }
    let data;
    try { data = JSON.parse(m[1]); } catch { return result('couldnt_check', 'layout_changed', [], pageUrl, '__NEXT_DATA__ is not JSON'); }

    const ap = data?.props?.pageProps?.apolloState?.data;
    if (!ap || typeof ap !== 'object') {
      return result('couldnt_check', 'layout_changed', [], pageUrl, 'no apolloState in page data');
    }
    const startup = Object.values(ap).find((v) => v && v.__typename === 'Startup' && v.slug === slug);
    if (!startup || typeof startup.name !== 'string') {
      return result('couldnt_check', 'layout_changed', [], pageUrl, 'no Startup record in page data');
    }

    // Match the company, not similar words: normalised names must be equal.
    if (nameKey(startup.name) !== nameKey(keyword)) {
      return result('not_found', '', [], pageUrl, `page at /company/${slug} is "${startup.name}", a different company`);
    }

    const tagNames = (refs) => (refs || [])
      .map((r) => (r && r.__ref ? ap[r.__ref] : r))
      .map((t) => (t && (t.displayName || t.name)) || '')
      .filter(Boolean);

    const record = {
      name: startup.name,
      slug: startup.slug,
      high_concept: startup.highConcept || '',
      company_size: startup.companySize || '',
      company_url: startup.companyUrl || '',
      locations: tagNames(startup.locationTaggings),
      markets: tagNames(startup.marketTaggings),
      total_raised_amount: startup.totalRaisedAmount ?? null,
      hiring: startup.hiring ?? null,
      page_url: pageUrl,
    };
    return result('found', '', [record], pageUrl, `${record.name} | ${record.high_concept} | ${record.company_size}`);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return result('couldnt_check', timedOut ? 'timeout' : 'other', [], pageUrl, String(err?.message || err));
  }
}
