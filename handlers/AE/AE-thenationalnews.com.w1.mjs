export const meta = {
  task: 'AE-thenationalnews.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['title', 'url', 'published', 'summary'],
  canary: { found: 'Emirates NBD', not_found: 'شركة وهمية غير مدرجة للتجارة ذ.م.م' },
};

// The National's own search page loads a public Queryly search widget. The widget's search key is written in
// the widget script, so the handler reads it from there (no key is stored here), then calls the same JSON search.
// The site is a news site: a "found" means the company is named in a headline or summary of its coverage.

const SITE = 'https://www.thenationalnews.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_WIDGET = 'https://www.queryly.com/js/thenational-advanced-search-2024.js';

// Legal-form words, removed only from the END of the name (so "Vitamin C" keeps its C).
const LEGAL_SEQS = [
  ['pjsc'], ['psc'], ['jsc'], ['llc'], ['fze'], ['fzc'], ['fzco'], ['fzllc'], ['ltd'], ['limited'], ['plc'], ['inc'],
  ['corp'], ['corporation'], ['company'], ['co'], ['gmbh'], ['bsc'], ['sal'], ['lp'], ['llp'],
  ['p', 'j', 's', 'c'], ['l', 'l', 'c'], ['f', 'z', 'c', 'o'], ['f', 'z', 'e'], ['s', 'a', 'l'], ['b', 's', 'c'],
  ['ش', 'م', 'ع'], ['ش', 'م', 'ح'], ['ش', 'م', 'خ'], ['ش', 'ذ', 'م', 'م'], ['ذ', 'م', 'م'],
];

function clean(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics and tatweel
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Same as clean(), plus Arabic letter variants folded together, used only for comparing.
function matchForm(s) {
  return clean(s)
    .replace(/[آأإ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

function nameTokens(name) {
  let t = clean(name).split(' ').filter(Boolean);
  let changed = true;
  while (changed && t.length) {
    changed = false;
    for (const seq of LEGAL_SEQS) {
      if (t.length > seq.length && seq.every((w, i) => t[t.length - seq.length + i] === w)) {
        t = t.slice(0, t.length - seq.length);
        changed = true;
        break;
      }
    }
  }
  return t;
}

function hasPhrase(haystack, needle) {
  return haystack && (' ' + haystack + ' ').includes(' ' + needle + ' ');
}

function toErr(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword ?? '').trim();
  const searchUrl = `${SITE}/search/?q=${encodeURIComponent(name)}`;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 300) });
  const get = (url, accept) => fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept, 'Referer': `${SITE}/search/` },
    signal: AbortSignal.timeout(25000),
  });

  try {
    const words = nameTokens(name);
    if (!words.length) return fail('other', 'no usable company name after removing the legal form');
    const query = words.join(' ');
    const needle = words.map(matchForm).join(' ');

    // 1. The search page: must answer normally and carry the search widget.
    const page = await get(searchUrl, 'text/html,application/xhtml+xml,*/*;q=0.8');
    if (page.status === 403 || page.status === 429) return fail('blocked', `HTTP ${page.status}`);
    if (!page.ok) return fail('http_error', `HTTP ${page.status}`);
    const html = await page.text();
    if (!html.includes('queryly')) return fail('layout_changed', 'search page has no search widget');
    const scriptMatch = html.match(/https:\/\/www\.queryly\.com\/js\/[^"'\s<>]+\.js/);
    const widgetUrl = scriptMatch ? scriptMatch[0] : DEFAULT_WIDGET;

    // 2. The widget script: holds the public search key.
    const js = await get(widgetUrl, '*/*');
    if (js.status === 403 || js.status === 429) return fail('blocked', `widget HTTP ${js.status}`);
    if (!js.ok) return fail('http_error', `widget HTTP ${js.status}`);
    const keyMatch = (await js.text()).match(/queryly_key:\s*['"]([0-9a-f]{16})['"]/);
    if (!keyMatch) return fail('layout_changed', 'no search key in the widget script');

    // 3. The JSON search itself.
    const apiUrl = `https://api.queryly.com/json.aspx?queryly_key=${keyMatch[1]}&query=${encodeURIComponent(query)}&endindex=0&batchsize=50`;
    const api = await get(apiUrl, 'application/json,*/*;q=0.8');
    if (api.status === 403 || api.status === 429) return fail('blocked', `search HTTP ${api.status}`);
    if (!api.ok) return fail('http_error', `search HTTP ${api.status}`);
    let data;
    try { data = JSON.parse(await api.text()); } catch { return fail('layout_changed', 'search answer is not JSON'); }
    if (!data || !Array.isArray(data.items)) return fail('layout_changed', 'search answer has no items list');

    // 4. Keep only the items whose headline or summary really names the company (whole words, in order).
    const records = [];
    for (const it of data.items) {
      const title = matchForm(it.title);
      const summary = matchForm(it.description);
      if (hasPhrase(title, needle) || hasPhrase(summary, needle)) {
        records.push({
          title: String(it.title ?? ''),
          url: new URL(String(it.link ?? ''), SITE).href,
          published: String(it.pubdate ?? ''),
          summary: String(it.description ?? ''),
        });
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: `${records[0].title} (${records[0].published})`.slice(0, 300),
      };
    }
    const total = data.metadata && data.metadata.total != null ? data.metadata.total : '?';
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `Search returned ${data.items.length} of ${total} items; none has "${query}" in its headline or summary`.slice(0, 300),
    };
  } catch (err) {
    return fail(toErr(err), String(err && err.message ? err.message : err));
  }
}
