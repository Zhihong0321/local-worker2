export const meta = {
  task: 'MY-chinapress.com.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['title', 'post_date', 'url', 'post_id', 'matched_in', 'snippet'],
  canary: { found: 'MRCB LAND SDN BHD', not_found: '零零零不存在公司名' },
};

// The site's own search page (https://www.chinapress.com.my/?s=...) loads its results from this JSON API.
const API_URL = 'https://search.chinapress.com.my/full-search';
const SEARCH_PAGE = 'https://www.chinapress.com.my/?s=';
const ARTICLE_URL = 'https://www.chinapress.com.my/?p=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;          // hits per API page, as the site's own search page asks for
const MAX_HITS = 100;          // at most 100 hits are checked; more than that is couldnt_check, never not_found
const PAGE_TIMEOUT_MS = 25000; // every fetch
const NO_NEW_PAGE_AFTER_MS = 30000; // keeps the whole call under 60 s

// Legal-form words are dropped before matching, so "ACME TRADING SDN BHD" searches for and matches "ACME TRADING".
const LEGAL_FORMS = [/\(\s*m\s*\)/gi, /\bsdn\.?\s*bhd\.?/gi, /\bberhad\b/gi, /\bbhd\.?/gi, /\bllp\b/gi, /\bplt\b/gi,
  /私人有限公司/g, /有限公司/g];

function coreName(keyword) {
  let s = String(keyword || '').normalize('NFKC');
  for (const re of LEGAL_FORMS) s = s.replace(re, ' ');
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Words in order; any non-letter/digit (space, dot, hyphen) may sit between them. ASCII edges need a
// non-letter boundary so "MRCB" does not match inside "MRCBX". Case-insensitive.
function buildMatcher(core) {
  const body = core.split(' ').filter(Boolean).map(escapeRe).join('[^\\p{L}\\p{N}]*');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'iu');
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function matchHit(hit, matcher) {
  const s = hit && hit._source;
  if (!s) return null;
  const title = stripTags(s.post_title);
  const content = stripTags(s.post_content);
  let src = null;
  let where = '';
  if (matcher.test(title)) { src = title; where = 'title'; }
  else if (matcher.test(content)) { src = content; where = 'body'; }
  if (!src) return null;
  matcher.lastIndex = 0;
  const m = src.match(matcher);
  const snippet = src.slice(Math.max(0, m.index - 60), m.index + m[0].length + 120).trim();
  return {
    title,
    post_date: s.post_date || '',
    url: s.post_id != null ? ARTICLE_URL + s.post_id : '',
    post_id: s.post_id != null ? s.post_id : null,
    matched_in: where,
    snippet,
  };
}

function isTimeout(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function failure(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const sourceUrl = SEARCH_PAGE + encodeURIComponent(String(keyword || '').trim());
  try {
    const core = coreName(keyword);
    if (!core) return failure('other', sourceUrl, 'no company name left once the legal form is removed');
    const matcher = buildMatcher(core);

    const records = [];
    let total = null;
    let offset = 0;
    let checked = 0;
    let stoppedEarly = '';

    while (true) {
      if (offset > 0 && total !== null && offset >= total) break;
      if (offset >= MAX_HITS) break;
      if (offset > 0 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) { stoppedEarly = 'time limit'; break; }

      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json, text/plain, */*',
          },
          body: JSON.stringify({ id: 'a1', params: { query_string: core.toLowerCase(), query_from: offset } }),
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        });
      } catch (err) {
        if (offset === 0) return failure(isTimeout(err) ? 'timeout' : 'other', sourceUrl, err && err.message);
        stoppedEarly = 'a later page failed: ' + (isTimeout(err) ? 'timeout' : 'other');
        break;
      }

      if (res.status === 403 || res.status === 429) {
        if (offset === 0) return failure('blocked', sourceUrl, `HTTP ${res.status}`);
        stoppedEarly = `a later page returned HTTP ${res.status}`;
        break;
      }
      if (!res.ok) {
        if (offset === 0) return failure('http_error', sourceUrl, `HTTP ${res.status}`);
        stoppedEarly = `a later page returned HTTP ${res.status}`;
        break;
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        if (offset === 0) return failure('layout_changed', sourceUrl, 'search API did not return JSON');
        stoppedEarly = 'a later page was not JSON';
        break;
      }

      if (!data || !data.hits || typeof data.hits !== 'object') {
        if (offset === 0) return failure('layout_changed', sourceUrl, JSON.stringify(data).slice(0, 300));
        stoppedEarly = 'a later page had no hits object';
        break;
      }
      const t = data.hits.total;
      const totalNow = t && typeof t === 'object' ? t.value : t;
      if (typeof totalNow !== 'number') {
        if (offset === 0) return failure('layout_changed', sourceUrl, 'hits.total missing');
        stoppedEarly = 'a later page had no hit total';
        break;
      }
      total = totalNow;

      const hits = Array.isArray(data.hits.hits) ? data.hits.hits : [];
      for (const h of hits) {
        const rec = matchHit(h, matcher);
        if (rec) records.push(rec);
      }
      checked += hits.length;
      offset += PAGE_SIZE;
      if (hits.length < PAGE_SIZE) break;
    }

    const base = `${total ?? 0} search hit(s) for "${core}", ${checked} checked, ${records.length} name the company in the text`;
    const tail = stoppedEarly ? `; stopped: ${stoppedEarly}` : '';

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: (base + tail).slice(0, 300),
      };
    }

    // Nothing matched by name. That is only "not found" when every hit was checked and the site answered normally.
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: `0 search hits for "${core}"` };
    }
    if ((total ?? 0) > checked || stoppedEarly) {
      return failure('other', sourceUrl, `no name match in the ${checked} of ${total} hits checked${tail}`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: base };
  } catch (err) {
    return failure('other', sourceUrl, err && err.message ? err.message : err);
  }
}
