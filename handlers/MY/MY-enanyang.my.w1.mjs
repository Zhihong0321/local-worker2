export const meta = {
  task: 'MY-enanyang.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['title', 'date', 'url', 'category', 'text'],
  canary: { found: 'BERJAYA CORPORATION BERHAD', not_found: '无名测试有限公司' },
};

// eNanyang has no company register. Its own search box calls this JSON search and lists the news articles
// that match. A company counts as "found" only when its name (legal form removed) appears in an article.
const SITE = 'https://www.enanyang.my';
const SEARCH_API = 'https://search.enanyang.my/full-search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const MAX_PAGES = 5;          // at most 50 hits checked per lookup
const STOP_AFTER_MS = 30000;  // no new page request after 30 s, so the whole call stays under 60 s
const LEGAL_EN = new Set(['SDN', 'BHD', 'BERHAD', 'PLT', 'LTD', 'LIMITED', 'PTE', 'CO', 'COMPANY', 'INC']);
const LEGAL_ZH = ['股份有限公司', '有限责任公司', '有限公司', '（马来西亚）', '(马来西亚)', '（大马）', '(大马)'];
const CJK = /[㐀-鿿豈-﫿]/;

/** The name to search for and to match, with the legal form removed. */
function coreName(keyword) {
  const s = String(keyword || '').trim();
  if (CJK.test(s)) {
    let core = s;
    for (const suf of LEGAL_ZH) if (core.endsWith(suf)) core = core.slice(0, -suf.length).trim();
    const key = core.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    return { query: core, key, words: [], cjk: true };
  }
  const words = s.toUpperCase().replace(/\(M\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  while (words.length && LEGAL_EN.has(words[words.length - 1])) words.pop();
  const lower = words.map((w) => w.toLowerCase());
  return { query: lower.join(' '), key: '', words: lower, cjk: false };
}

/** True when the article text names the company (whole words for English, substring for Chinese). */
function namesCompany(text, core) {
  if (core.cjk) return text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase().includes(core.key);
  const spaced = ' ' + text.replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim() + ' ';
  return spaced.includes(' ' + core.words.join(' ') + ' ');
}

function plain(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function out(status, reason, records, sourceUrl, excerpt) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let sourceUrl = SITE;
  try {
    const core = coreName(keyword);
    if (!core.query || (!core.cjk && core.words.length === 0)) {
      return out('couldnt_check', 'other', [], sourceUrl, 'no company name left after removing the legal form');
    }
    sourceUrl = SITE + '/?s=' + encodeURIComponent(core.query);

    const records = [];
    let total = 0;
    let checked = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - started > STOP_AFTER_MS) break;
      const res = await fetch(SEARCH_API, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json, */*;q=0.8',
          'Origin': SITE,
          'Referer': sourceUrl,
        },
        body: JSON.stringify({ id: 'a1', params: { query_string: core.query, query_from: page * PAGE_SIZE } }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return out('couldnt_check', 'blocked', [], sourceUrl, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return out('couldnt_check', 'http_error', [], sourceUrl, `HTTP ${res.status}`);
      }
      let data;
      try { data = JSON.parse(await res.text()); } catch { data = null; }
      if (!data || !data.hits || !Array.isArray(data.hits.hits) || typeof data.hits.total?.value !== 'number') {
        return out('couldnt_check', 'layout_changed', [], sourceUrl, 'search answer has no hits list');
      }
      total = data.hits.total.value;
      const hits = data.hits.hits;
      checked += hits.length;
      for (const hit of hits) {
        const src = hit?._source || {};
        const title = plain(src.post_title);
        const body = plain(src.post_content);
        if (!namesCompany(title + ' ' + body, core)) continue;
        records.push({
          title,
          date: src.post_date || '',
          url: src.post_id ? `${SITE}/?p=${src.post_id}` : '',
          category: src.cat_label || '',
          text: body.slice(0, 200),
        });
      }
      if (hits.length === 0 || checked >= total) break;
    }

    if (records.length > 0) {
      return out('found', '', records, sourceUrl,
        `${records.length} article(s) name the company; checked ${checked} of ${total} search hits`);
    }
    if (checked >= total) {
      return out('not_found', '', [], sourceUrl, `0 of ${total} search hits name the company`);
    }
    return out('couldnt_check', 'other', [], sourceUrl,
      `search returned ${total} hits; checked ${checked}, none named the company, so the result is not conclusive`);
  } catch (err) {
    const timed = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return out('couldnt_check', timed ? 'timeout' : 'other', [], sourceUrl, String(err?.message || err));
  }
}
