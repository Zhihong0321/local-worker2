export const meta = { task: 'JP-aperza.com', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'company_id', 'company_url', 'catalog_hits'],
  canary: { found: 'アドバンテック株式会社', not_found: 'ゼズノア商事株式会社' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.aperza.com';

// Compare names: full-width/half-width, case, spaces, punctuation and Japanese legal forms ignored.
function normalize(str) {
  return (str || '').normalize('NFKC').toLowerCase()
    .replace(/\((株|有|合同|合資|合名|同|相互)\)/g, '')
    .replace(/(株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|会社)/g, '')
    .replace(/co\.?,?\s*ltd\.?|inc\.?|corp\.?|corporation|company|limited/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function decodeEntities(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

/** Look one company up on Aperza's catalog search. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}/ja/s/catalog/?k=${encodeURIComponent(keyword)}`;
  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();

    // Zero results: the site says so in plain words.
    if (html.includes('合致する製品がみつかりませんでした')) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: 'ご指定の検索条件に合致する製品がみつかりませんでした。' };
    }

    // Results header: "検索結果：N件中 1-30件を表示" (N may have commas).
    const totalMatch = html.match(/検索結果：\s*([\d,]+)件中/);
    if (!totalMatch) {
      if (/cf-chl|Just a moment|Attention Required|g-recaptcha|h-captcha/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: html.slice(0, 300) };
    }
    const total = Number(totalMatch[1].replace(/,/g, ''));
    // "件中 1-30件を表示": the last result number shown on this page.
    const rangeMatch = html.match(/件中\s*([\d,]+)\s*-\s*([\d,]+)\s*件/);
    const shownEnd = rangeMatch ? Number(rangeMatch[2].replace(/,/g, '')) : 0;

    // Every result card carries its company name and id as data attributes.
    const tags = html.match(/<[^>]*data-ev_company_name="[^"]*"[^>]*>/g) || [];
    const seen = new Map(); // company id -> { name, hits }
    for (const tag of tags) {
      const nm = tag.match(/data-ev_company_name="([^"]*)"/);
      const id = tag.match(/data-ev_company_id="(\d+)"/);
      if (!nm || !id) continue;
      const cur = seen.get(id[1]) || { name: decodeEntities(nm[1]), hits: 0 };
      cur.hits += 1;
      seen.set(id[1], cur);
    }
    if (total > 0 && seen.size === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl,
        excerpt: `header says ${total} results but no company fields found` };
    }

    const kwNorm = normalize(keyword);
    const records = [];
    for (const [id, c] of seen) {
      if (kwNorm && normalize(c.name) === kwNorm) {
        records.push({ name: c.name, company_id: id, company_url: `${BASE}/company/page/${id}/`, catalog_hits: c.hits });
      }
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: `${records.length} company match(es) among ${total} catalog results` };
    }

    // No name match. Only a full result list (every result on this one page) proves it is absent.
    if (shownEnd >= total) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${total} catalog results, no company named like the keyword` };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
      excerpt: `no name match on the first page of ${total} results; later pages are not read by this handler` };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
