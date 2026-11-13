export const meta = { task: 'US-sitejabber.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'domain', 'title', 'subindustry', 'founded', 'website', 'reviews', 'rating', 'is_closed', 'is_removed', 'is_prohibited', 'review_page'],
  canary: { found: 'Apple', not_found: 'Zqxvbrandt Holdings LLC' } };

// SiteJabber now runs on SmartCustomer: www.sitejabber.com redirects to smartcustomer.com, and its search page
// reads the public JSON API below (no login, no key). Search is by name/keyword; exact name matches rank first.
const API = 'https://api.smartcustomer.com/v2/businesses';
const SITE = 'https://www.sitejabber.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LEGAL_FORMS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'lp', 'llp', 'lllp', 'plc', 'pllc', 'pc', 'na']);

/** Letters and digits only, lower case: "Amazon.com, Inc." -> "amazoncominc". */
function normalize(s) {
  return String(s || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Drop a trailing legal form: "ACME TRADING, LLC" -> "ACME TRADING". */
function stripLegalForm(keyword) {
  const tokens = String(keyword || '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(normalize(tokens[tokens.length - 1]))) tokens.pop();
  return tokens.join(' ');
}

/** "www.amazon.com" -> "amazoncom" (the site lists each business with its website as display_address). */
function domainKey(display) {
  const host = String(display || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  return normalize(host);
}

const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };

/** Node on Windows aborts (exit 127, libuv assertion) if the runner exits while the last keep-alive socket is still
 *  closing. A short settle after the answer lets that socket finish closing before the runner exits. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  await settle();
  return answer;
}

async function search(keyword) {
  try {
    const cleaned = stripLegalForm(keyword) || String(keyword || '').trim();
    if (!cleaned) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty company name' };
    }

    const searchUrl = `${API}?${new URLSearchParams({ query: cleaned, per_page: '100' })}`;
    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|verify you are human|access denied/i.test(text.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: text.slice(0, 200) };
    }

    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json || !Array.isArray(json.data) || !json.meta || !json.meta.pagination) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }

    // Match the company, not just similar words: the normalised name, or the normalised website domain.
    const key = normalize(cleaned);
    const matches = json.data.filter((b) =>
      normalize(b.name) === key || (b.display_address && domainKey(b.display_address) === key));

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 listed businesses named "${cleaned}" (${json.meta.pagination.count} results for the search)`,
      };
    }

    const records = matches.map((b) => ({
      name: b.name || '',
      domain: b.display_address || '',
      title: b.title || '',
      subindustry: b.subindustry || '',
      founded: b.founded ?? null,
      website: b.address || '',
      reviews: b.review_numbers?.reviews ?? null,
      rating: b.average_ratings?.rating ?? null,
      is_closed: !!b.is_closed,
      is_removed: !!b.is_removed,
      is_prohibited: !!b.is_prohibited,
      review_page: b.display_address ? `${SITE}/reviews/${String(b.display_address).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]}` : '',
    }));

    return {
      status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: String(matches[0].ai_summary || matches[0].title || '').slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [],
      source_url: API, excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
