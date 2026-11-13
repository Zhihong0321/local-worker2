export const meta = {
  task: 'US-cbinsights.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'cb_url', 'founded_year', 'stage', 'total_raised', 'headquarters'],
  canary: { found: 'Stripe', not_found: 'Zzqxvbk Holdings Xyz' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.cbinsights.com';

// Legal-form words that CB Insights does not put in its profile slugs or names.
const LEGAL_WORDS = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'lp', 'llp', 'pllc', 'gmbh', 'sa', 'ag', 'pte', 'sdn', 'bhd',
]);

function cleanText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Name words without punctuation, without "&"/"and" and without the legal form, lower case. */
function nameWords(str) {
  return cleanText(str)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'and' && !LEGAL_WORDS.has(w));
}

/** Profile slug CB Insights uses: "Stripe, Inc." -> "stripe", "Johnson & Johnson" -> "johnson-johnson". */
function slugFor(keyword) {
  return nameWords(keyword).join('-');
}

function normName(str) {
  return nameWords(str).join('');
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = '';
  try {
    const slug = slugFor(keyword);
    if (!slug) return couldnt('other', BASE, 'the company name has no letters or digits to build a profile address');
    url = `${BASE}/company/${slug}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    // A redirect into a login page means the public profile is not open to us.
    if (res.url && /app\.cbinsights\.com\/login|\/login/i.test(res.url)) {
      return couldnt('blocked', res.url, 'redirected to a login page');
    }
    if (res.status === 404) {
      // The site answered normally: no public profile at this address.
      return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `no CB Insights profile at ${url} (HTTP 404)` };
    }
    if (res.status === 403 || res.status === 429) {
      return couldnt('blocked', url, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return couldnt('http_error', url, `HTTP ${res.status}`);
    }

    const html = await res.text();
    const text = cleanText(html);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const pageName = h1 ? cleanText(h1[1]) : '';
    const isProfile = !!pageName && /Founded Year|Total Raised|Headquarters Location|Alive|Overview/i.test(text);

    if (!isProfile) {
      // Only a real bot wall counts; the word "captcha" in article text does not.
      if (/cf-challenge|challenge-platform|verify you are human|g-recaptcha|hcaptcha/i.test(html)) {
        return couldnt('blocked', url, 'bot check or captcha page');
      }
      return couldnt('layout_changed', url, text.slice(0, 300));
    }

    // Match the company, not just similar words: the profile name must equal the asked name once normalised.
    if (normName(pageName) !== normName(keyword)) {
      return couldnt('other', url, `profile at this address is named "${pageName}", not "${keyword}"; not confirmed`);
    }

    const founded = text.match(/Founded Year\s*(\d{4})/i);
    const raised = text.match(/Total Raised\s*(\$[\d.,]+\s*[KMBT]?)/i);
    const stage = text.match(/Stage\s+(.+?)\s*\|/i);
    // "Headquarters Location" (not the nav's "Headquarters Locations"), value up to the phone number.
    const hq = text.match(/Headquarters Location(?!s)\s+(.+?)\s*(?:\d{3}-\d{3}-\d{4}|Loading|ESPs|$)/i);

    return {
      status: 'found',
      reason: '',
      records: [{
        name: pageName,
        cb_url: url,
        founded_year: founded ? founded[1] : '',
        stage: stage ? stage[1].trim() : '',
        total_raised: raised ? raised[1].trim() : '',
        headquarters: hq ? hq[1].trim().slice(0, 200) : '',
      }],
      source_url: url,
      excerpt: text.slice(0, 500),
    };
  } catch (err) {
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(aborted ? 'timeout' : 'other', url || BASE, String(err?.message || err));
  }
}
