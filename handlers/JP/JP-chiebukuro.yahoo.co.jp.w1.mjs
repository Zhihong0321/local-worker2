export const meta = {
  task: 'JP-chiebukuro.yahoo.co.jp',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['title', 'url', 'asked_at', 'resolved', 'summary'],
  canary: { found: 'トヨタ自動車株式会社', not_found: 'ゼノン商事株式会社架空テスト' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Japanese and common English legal-form words, removed before matching.
const LEGAL_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|一般社団法人|一般財団法人|社団法人|財団法人|特定非営利活動法人|\(株\)|\(有\)|\(合\)|\bco\.?|\bltd\.?|\binc\.?|\bcorp\.?|\bcorporation\b|\bllc\b/gi;

/** Search query 1: the name as the user typed it (legal form kept), width-normalised. */
function fullQuery(keyword) {
  return String(keyword || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Search query 2: the name without legal form. The site's search finds other titles with it. */
function coreQuery(keyword) {
  return String(keyword || '')
    .normalize('NFKC')
    .replace(LEGAL_FORMS, ' ')
    .replace(/[\s()'".,、。・･]+/g, ' ')
    .trim();
}

/** Matching key: lower case, no spaces, no punctuation (site titles contain inserted spaces). */
function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{Lm}\p{N}]/gu, '');
}

function decode(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function answer(status, reason, sourceUrl, excerpt, records = []) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/**
 * One search request. Returns { problem } for a refusal or a page that is not what we expect,
 * otherwise { items, noResults, url } with the parsed result list.
 */
async function search(query) {
  const url = `https://chiebukuro.yahoo.co.jp/search/?p=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (res.status === 403 || res.status === 429) return { problem: answer('couldnt_check', 'blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { problem: answer('couldnt_check', 'http_error', url, `HTTP ${res.status}`) };
  if (/login\.yahoo\.co\.jp/i.test(res.url || '')) return { problem: answer('couldnt_check', 'blocked', url, `redirected to login: ${res.url}`) };

  const html = await res.text();
  const items = [...html.matchAll(/<li class="[^"]*ListSearchResults_listSearchResults__listItem[^"]*"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  if (items.length > 0) return { items, url };

  const text = decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
  if (/見つかりませんでした/.test(text)) return { items: [], url, noResults: true };
  if (/captcha/i.test(html)) return { problem: answer('couldnt_check', 'blocked', url, 'captcha or bot check page') };
  return { problem: answer('couldnt_check', 'layout_changed', url, text.slice(0, 300)) };
}

/** Keep the result items whose title or snippet names the company (normalised). */
function matchItems(items, key) {
  const out = [];
  for (const body of items) {
    const a = body.match(/<h3[^>]*>\s*<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = decode(a[2]);
    const summaryM = body.match(/<p class="[^"]*listSearchResults__summary[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const summary = summaryM ? decode(summaryM[1]) : '';
    if (!norm(`${title} ${summary}`).includes(key)) continue;
    const dateM = body.match(/質問日時：<\/span><span>([^<]+)<\/span>/);
    const url = new URL(a[1].replace(/&amp;/gi, '&'), 'https://detail.chiebukuro.yahoo.co.jp');
    url.search = '';
    out.push({
      title,
      url: url.href,
      asked_at: dateM ? dateM[1].trim() : '',
      resolved: body.includes('listSearchResults__informationStatus--resolved'),
      summary,
    });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const key = norm(coreQuery(keyword));
    if (!key) return answer('couldnt_check', 'other', '', 'no company name left after removing the legal form');

    const queries = [...new Set([fullQuery(keyword), coreQuery(keyword)].filter(Boolean))];
    const records = [];
    const seen = new Set();
    const notes = [];

    for (const query of queries) {
      const r = await search(query);
      searchUrl = r.url || searchUrl;
      if (r.problem) return r.problem;
      notes.push(r.noResults ? `"${query}": no Q&A` : `"${query}": ${r.items.length} Q&A on page 1`);
      for (const rec of matchItems(r.items, key)) {
        if (seen.has(rec.url)) continue;
        seen.add(rec.url);
        records.push(rec);
      }
    }

    if (records.length > 0) return answer('found', '', searchUrl, records[0].title, records);
    return answer('not_found', '', searchUrl, `no question names "${key}" (${notes.join('; ')})`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer('couldnt_check', timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
