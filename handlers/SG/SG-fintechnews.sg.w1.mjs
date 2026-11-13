export const meta = {
  task: 'SG-fintechnews.sg',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'startup_category', 'founded_in', 'website', 'description', 'directory_url'],
  canary: { found: '2C2P', not_found: '新加坡虚构金融科技私人有限公司' },
};

const BASE = 'https://fintechnews.sg/list-fintech-startup-singapore-fintech-companies-directory/fintech/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL = /\s*(pte\.?\s*ltd\.?|private\s+limited|pvt\.?\s*ltd\.?|ltd\.?|limited|sdn\.?\s*bhd\.?|bhd\.?|llp|llc|inc\.?|corp\.?|corporation|plc|pte\.?|私人有限公司|有限公司|有限责任公司)\s*$/i;

/** Drop a trailing legal form (PTE LTD, SDN BHD, ...), repeatedly, keeping the brand name. */
function stripLegal(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim().replace(/[.,]+$/, '');
  for (;;) {
    const t = s.replace(LEGAL, '').trim().replace(/[.,]+$/, '');
    if (!t || t === s) break;
    s = t;
  }
  return s;
}

/** Comparison key: accents, case, spaces and punctuation removed. */
function normKey(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Profile slug as the site builds it from a name (lowercase, separators become "-"). */
function slugFor(s, dropApostrophes) {
  let t = s.normalize('NFKC').toLowerCase();
  if (dropApostrophes) t = t.replace(/['’`]/g, '');
  return t.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = stripLegal(keyword);
    if (!normKey(name)) return fail('other', BASE, 'empty company name');

    // Each company has its own profile page at BASE + slug. Two slug spellings cover apostrophes.
    const slugs = [...new Set([slugFor(name, true), slugFor(name, false)])].filter(Boolean);
    let lastUrl = BASE;

    for (const slug of slugs) {
      const url = BASE + encodeURIComponent(slug) + '/';
      lastUrl = url;

      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return fail(timedOut ? 'timeout' : 'http_error', url, err?.message || err);
      }

      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);

      const body = await res.text();

      if (res.status === 404) {
        // The site's own "Page not found" answer: this slug has no company profile.
        if (/Page not found/i.test(body)) continue;
        return fail('layout_changed', url, `HTTP 404 without the site's not-found page`);
      }
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      if (!/Back to Singapore Fintech Startup Directory|drts-entity-post/.test(body)) {
        return fail('layout_changed', url, decode(body).slice(0, 300));
      }

      const h1 = decode((body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
      if (!h1 || normKey(stripLegal(h1)) !== normKey(name)) continue; // a different company's page

      // Profile text sits between the "Back to" link and "Read News".
      const text = decode(body);
      const start = text.indexOf('Back to Singapore Fintech Startup Directory');
      const seg = start >= 0 ? text.slice(start, text.indexOf('Read News', start) > start ? text.indexOf('Read News', start) : undefined) : text;
      const category = (seg.match(/Startup Category\s+(.+?)\s+(?=Founded in|Website|Social Accounts|$)/) || [])[1] || '';
      const founded = (seg.match(/Founded in\s+(\S+)/) || [])[1] || '';
      const website = (seg.match(/Website\s+(\S+)/) || [])[1] || '';
      const description = decode((body.match(/<meta name="description" content="([^"]*)"/i) || [])[1] || '');

      return {
        status: 'found',
        reason: '',
        records: [{
          name: h1,
          startup_category: category,
          founded_in: founded,
          website,
          description,
          directory_url: url,
        }],
        source_url: url,
        excerpt: (description || seg).slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `No directory profile for "${name}" (tried slugs: ${slugs.join(', ')})`,
    };
  } catch (err) {
    return fail('other', BASE, err?.message || err);
  }
}
