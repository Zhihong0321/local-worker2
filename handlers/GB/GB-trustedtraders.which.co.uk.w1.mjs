export const meta = { task: 'GB-trustedtraders.which.co.uk', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'telephone', 'email', 'website', 'street_address', 'locality', 'postcode', 'rating', 'review_count', 'profile_url'],
  canary: { found: 'Pleasant Plumbers Limited', not_found: 'Zqxv Nonexistent Holdings Ltd' } };

const BASE = 'https://trustedtraders.which.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = ['ltd', 'limited', 'llp', 'plc'];
const BUDGET_MS = 30000; // stop starting new fetches after this, so the whole call stays under 60 s

/** Lower-case, accents off, every run of non-letters/digits becomes one hyphen: the site's business slug. */
function slugify(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Name for comparison: case, punctuation, spaces and the legal form removed. */
function normName(s) {
  const words = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length && LEGAL.includes(words[words.length - 1])) words.pop();
  return words.join('');
}

/** The slug itself, then the same name with the legal form swapped (ltd <-> limited) or dropped. */
function slugVariants(keyword) {
  const base = slugify(keyword);
  const out = [base];
  const m = base.match(/^(.*)-(ltd|limited)$/);
  if (m) {
    out.push(`${m[1]}-${m[2] === 'ltd' ? 'limited' : 'ltd'}`);
    out.push(m[1]);
  }
  return [...new Set(out)];
}

function clean(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The business JSON-LD block (the one with an address and the Which? membership). */
function businessJsonLd(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      if (j && j.name && j.address && /Business|Organization/.test(String(j['@type'])) && j.memberOf) return j;
    } catch { /* not this block */ }
  }
  return null;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let lastUrl = '';
  try {
    const variants = slugVariants(keyword);
    if (!variants[0]) return fail('other', BASE, 'no letters or digits in the company name');
    const wanted = normName(keyword);

    for (let i = 0; i < variants.length; i++) {
      if (i > 0 && Date.now() - started > BUDGET_MS) {
        return fail('timeout', lastUrl, 'time budget used up before every name variant was checked');
      }
      const url = `${BASE}/businesses/${variants[i]}/`;
      lastUrl = url;
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return fail(timedOut ? 'timeout' : 'other', url, err && err.message);
      }

      // The site sends a missing business to /missing_business/<slug>/ with a 404: a normal "not listed" answer.
      if (res.url.includes('/missing_business/') || res.status === 404) {
        await res.text().catch(() => '');
        continue;
      }
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (/<title>[^<]*Attention Required[^<]*<\/title>|cf-chl-|id="challenge-form"/i.test(html.slice(0, 20000))) return fail('blocked', url, 'bot check page');

      const ld = businessJsonLd(html);
      if (!ld) return fail('layout_changed', url, html.slice(0, 300));

      if (normName(ld.name) !== wanted) continue; // same slug, different name: not this company

      const website = (html.match(/data-ga-_action="click_trader_website"[^>]*href="([^"]+)"/) || [])[1] || '';
      const addr = ld.address || {};
      const rating = ld.aggregateRating || {};
      return {
        status: 'found',
        reason: '',
        records: [{
          name: ld.name,
          telephone: ld.telephone || '',
          email: ld.email || '',
          website,
          street_address: addr.streetAddress || '',
          locality: addr.addressLocality || '',
          postcode: addr.postalCode || '',
          rating: rating.ratingValue != null ? String(rating.ratingValue) : '',
          review_count: rating.reviewCount != null ? String(rating.reviewCount) : '',
          profile_url: ld.url || url,
        }],
        source_url: url,
        excerpt: clean(html.match(/<h1[^>]*>[\s\S]*?<\/h1>/)?.[0] || ld.name).slice(0, 300),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${BASE}/businesses/${variants[0]}/`,
      excerpt: `No business page for ${variants.map((v) => `/businesses/${v}/`).join(', ')} (site answered 404 "missing_business")`,
    };
  } catch (err) {
    return fail('other', lastUrl || BASE, err && err.message);
  }
}
