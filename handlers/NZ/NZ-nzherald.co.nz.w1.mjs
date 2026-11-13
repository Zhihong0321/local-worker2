export const meta = {
  task: 'NZ-nzherald.co.nz',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['headline', 'published', 'url', 'summary', 'matched_in'],
  canary: { found: 'Fletcher Building', not_found: 'Whenua Tūpuna Kōhanga Limited' },
};

// The site's own search box (Queryly widget, public key from the page source) returns JSON for a query.
const QUERYLY_KEY = '90da610d5f2348c6';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'incorporated', 'inc', 'plc', 'llc', 'corporation', 'corp', 'company', 'co']);

/** Lower-case word tokens, macrons and accents removed (Whangārei -> whangarei), leading/inner "the" dropped. */
function tokens(str) {
  return (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && t !== 'the');
}

/** The company name without trailing legal-form words: "ACME TRADING LIMITED" -> ["acme", "trading"]. */
function coreName(keyword) {
  const t = tokens(keyword);
  while (t.length && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t;
}

/** True when `needle` appears as whole consecutive words inside `hay`. */
function hasPhrase(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const core = coreName(keyword);
    if (!core.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no company name in the input' };
    }
    const coreText = core.join(' ');
    searchUrl = `https://api.queryly.com/json.aspx?queryly_key=${QUERYLY_KEY}&query=${encodeURIComponent(coreText)}` +
      `&endindex=0&batchsize=20&showfaceted=false&timezoneoffset=-720`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const body = await res.text();
    if (/captcha|cf-chl|access denied/i.test(body.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: body.slice(0, 200) };
    }

    let data;
    try { data = JSON.parse(body); } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: body.slice(0, 300) };
    }
    if (!data || !Array.isArray(data.items) || typeof data.metadata?.total !== 'number') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: body.slice(0, 300) };
    }

    if (data.items.length === 0) {
      if (data.metadata.total === 0) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 results for "${coreText}"` };
      }
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: `site reports ${data.metadata.total} results but returned none` };
    }

    // A company counts as found only when its name appears as whole words in the headline or the summary.
    const records = [];
    for (const item of data.items) {
      const headlineHit = hasPhrase(tokens(item.title), core);
      const summaryHit = !headlineHit && hasPhrase(tokens(item.description), core);
      if (headlineHit || summaryHit) {
        records.push({
          headline: item.title || '',
          published: item.pubdate || '',
          url: new URL(item.link || '/', 'https://www.nzherald.co.nz').href,
          summary: item.description || '',
          matched_in: headlineHit ? 'headline' : 'summary',
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${data.items.length} site results for "${coreText}", none has the name in its headline or summary`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} NZ Herald article(s) name "${coreText}"; newest: ${records[0].headline} (${records[0].published})`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
