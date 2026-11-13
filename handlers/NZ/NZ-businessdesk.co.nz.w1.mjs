export const meta = { task: 'NZ-businessdesk.co.nz', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['company', 'headline', 'published', 'url', 'section', 'matched_in'],
  canary: { found: 'Fletcher Building', not_found: 'Te Kohatu Zorvex Limited' } };

// BusinessDesk is a news site. Its search box calls a JSON search API (Queryly) with the site's own public key,
// which is embedded in the homepage for the search box. This is not a login and not a secret.
const SITE = 'https://www.businessdesk.co.nz';
const QUERYLY_KEY = 'c502cd69da924a12';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_SUFFIX = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co']);

/** Lower case, no accents, no apostrophes, punctuation turned into single spaces. */
function foldText(str) {
  return String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Company name without its legal form: "Fletcher Building Limited" -> "fletcher building". */
function coreName(keyword) {
  const words = foldText(keyword).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** True only when the whole name appears as its own words, so "fletcher" does not match "fletcherville". */
function hasPhrase(text, phrase) {
  return (' ' + text + ' ').includes(' ' + phrase + ' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const core = coreName(keyword);
  const apiUrl = `https://api.queryly.com/json.aspx?queryly_key=${QUERYLY_KEY}&query=${encodeURIComponent(core)}` +
    '&endindex=0&batchsize=50&showfaceted=false&timezoneoffset=-720';
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: apiUrl, excerpt: String(excerpt).slice(0, 500) });
  try {
    if (!core) return fail('other', 'empty company name');
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': SITE + '/' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return fail('layout_changed', 'search answer is not JSON: ' + text.slice(0, 200)); }
    if (!data || !Array.isArray(data.items) || !data.metadata) return fail('layout_changed', 'search answer has no items list');

    // The search is fuzzy (it answers any query), so keep only articles that really name the company.
    const records = [];
    for (const item of data.items) {
      const inHeadline = hasPhrase(foldText(item.title), core);
      const inSummary = !inHeadline && hasPhrase(foldText(item.description), core);
      if (!inHeadline && !inSummary) continue;
      const path = String(item.link || '');
      records.push({
        company: core,
        headline: String(item.title || ''),
        published: String(item.pubdate || ''),
        url: new URL(path, SITE).href,
        section: path.split('/')[1] || '',
        matched_in: inHeadline ? 'headline' : 'summary',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: apiUrl,
        excerpt: `Site search returned ${data.items.length} result(s) (total ${data.metadata.total}) and none names "${core}" in its headline or summary`,
      };
    }
    return {
      status: 'found', reason: '', records, source_url: apiUrl,
      excerpt: `${records.length} article(s) name "${core}". First: ${records[0].headline}`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
