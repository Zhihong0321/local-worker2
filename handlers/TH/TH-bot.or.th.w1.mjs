export const meta = { task: 'TH-bot.or.th', want: 'w1', tier: 2, method: 'other', pdf: false, input: 'company name',
  fields: ['name', 'bot_id', 'as_of', 'details', 'detail_url'],
  canary: { found: 'ธนาคารกรุงเทพ จำกัด (มหาชน)', not_found: 'ไม่มีชื่อนี้เลยจริงๆ' } };

// BOT License Check (app.bot.or.th). Flow: GET the search page -> forgeryToken + session cookie ->
// POST SearchAuthorizedInfo (JSON, requesttoken header) -> HTML results list -> GET ViewDetail?id=N for matches.
const BASE = 'https://app.bot.or.th/BOTLicenseCheck';
const SEARCH_PAGE = BASE + '/License/Search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10;
const DEADLINE_MS = 50000;
const MAX_DETAILS = 3;

// Legal-form words, removed on both sides before comparing names.
const LEGAL = /บริษัท|จำกัด|\(มหาชน\)|มหาชน|บมจ\.?|บจก\.?|บจ\.?|หจก\.?|ห้างหุ้นส่วนจำกัด|public\s+company\s+limited|company\s+limited|co\.?\s*,?\s*ltd\.?|limited|ltd\.?|plc\.?|pcl\.?|\bco\b\.?/gi;

/** Search text: the name without its legal form, spaces kept (the site matches on words). */
function coreQuery(s) { return (s || '').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim(); }

/** Comparison key: lower case, no legal form, no spaces or punctuation. Thai marks (\p{M}) are kept. */
function matchKey(s) {
  return (s || '').normalize('NFC').toLowerCase().replace(LEGAL, ' ').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function decode(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function textOf(html) {
  return decode((html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

function browserHeaders(extra = {}) {
  return { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8', ...extra };
}

function out(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const query = coreQuery(kw) || kw;
  const searchUrl = SEARCH_PAGE + '?query=' + encodeURIComponent(query);
  try {
    if (!kw) return out('couldnt_check', 'other', SEARCH_PAGE, 'empty keyword');

    // 1. Search page: token and session cookie.
    const home = await fetch(searchUrl, { headers: browserHeaders(), signal: AbortSignal.timeout(25000) });
    if (home.status === 403 || home.status === 429) return out('couldnt_check', 'blocked', searchUrl, `HTTP ${home.status}`);
    if (!home.ok) return out('couldnt_check', 'http_error', searchUrl, `HTTP ${home.status}`);
    const homeHtml = await home.text();
    if (/under maintenance/i.test(homeHtml)) return out('couldnt_check', 'other', searchUrl, 'site shows the maintenance page');
    const tok = homeHtml.match(/id="forgeryToken" value="([^"]+)"/);
    if (!tok) return out('couldnt_check', 'layout_changed', searchUrl, homeHtml.slice(0, 300));
    const token = tok[1];
    const cookies = cookieHeader(home);

    // 2. Results, page by page, keeping only entries whose name matches the keyword.
    const want = matchKey(kw);
    const seen = new Set();
    const matches = [];
    let page = 1;
    let maxPage = 1;
    let resultsSeen = 0;
    let sawNoData = false;
    while (page <= maxPage) {
      if (page > MAX_PAGES) return out('couldnt_check', 'other', searchUrl, `more than ${MAX_PAGES} result pages; not all checked`);
      if (Date.now() - started > DEADLINE_MS) return out('couldnt_check', 'timeout', searchUrl, 'stopped before all result pages were checked');

      const res = await fetch(BASE + '/License/SearchAuthorizedInfo', {
        method: 'POST',
        headers: browserHeaders({
          'requesttoken': token,
          'Content-Type': 'application/json; charset=utf-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': searchUrl,
          ...(cookies ? { Cookie: cookies } : {}),
        }),
        body: JSON.stringify({ query, type: '', page }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
      if (!res.ok) return out('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status} on page ${page}`);
      const frag = await res.text();
      if (/under maintenance/i.test(frag)) return out('couldnt_check', 'other', searchUrl, 'site shows the maintenance page');

      const anchors = [...frag.matchAll(/<a\s[^>]*href="[^"]*ViewDetail\?id=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
      if (page === 1) {
        if (/ไม่พบข้อมูล/.test(frag)) sawNoData = true;
        if (anchors.length === 0 && !sawNoData) return out('couldnt_check', 'layout_changed', searchUrl, textOf(frag).slice(0, 300));
        const pages = [...frag.matchAll(/data-page="(\d+)"/g)].map((m) => Number(m[1]));
        maxPage = Math.max(1, ...pages);
      }
      for (const m of anchors) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        resultsSeen += 1;
        const label = textOf(m[2]);
        if (matchKey(label) === want) matches.push({ id, label });
      }
      page += 1;
    }

    // 3. Not on the site: the search answered normally and no entry matches.
    if (matches.length === 0) {
      const excerpt = sawNoData && resultsSeen === 0
        ? `ไม่พบข้อมูล: 0 results for "${query}"`
        : `${resultsSeen} result(s) for "${query}", none with the same name`;
      return out('not_found', '', searchUrl, excerpt);
    }

    // 4. Detail page for each matching entry.
    const records = [];
    for (const m of matches.slice(0, MAX_DETAILS)) {
      const detailUrl = `${BASE}/License/ViewDetail?id=${m.id}`;
      const d = await fetch(detailUrl, { headers: browserHeaders(cookies ? { Cookie: cookies } : {}), signal: AbortSignal.timeout(25000) });
      if (!d.ok) return out('couldnt_check', 'http_error', detailUrl, `HTTP ${d.status} on detail page`);
      const dt = textOf(await d.text());
      if (!dt.includes('ประเภทใบอนุญาต')) return out('couldnt_check', 'layout_changed', detailUrl, dt.slice(0, 300));
      const asOf = (dt.match(/ข้อมูล ณ วันที่\s*(.{0,40}?เวลา\s*\d{1,2}:\d{2})/) || [])[1] || '';
      const start = Math.max(0, dt.indexOf(m.label) >= 0 ? dt.indexOf(m.label) : dt.indexOf('ข้อมูล ณ วันที่'));
      const end = dt.indexOf('หมายเหตุ', start);
      const details = dt.slice(start, end > start ? end : start + 3000).slice(0, 3000);
      records.push({ name: m.label, bot_id: m.id, as_of: asOf, details, detail_url: detailUrl });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].detail_url,
      excerpt: records[0].details.slice(0, 500),
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return out('couldnt_check', reason, searchUrl, String((err && err.message) || err));
  }
}
