export const meta = { task: 'JP-courts.go.jp', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['summary', 'judgment_url', 'parties', 'match_basis'],
  canary: { found: 'ソニーグループ（株）', not_found: '存在しないダミー株式会社ゼロワン' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.courts.go.jp';
const SEARCH_URL = (q) => `${BASE}/hanrei/search1/index.html?query1=${encodeURIComponent(q)}`;
const DEADLINE_MS = 40000;   // time budget for checking hits; the whole call must finish under 60 s
const BATCH = 6;             // judgment pages fetched in parallel
const PAGE_SIZE = 30;        // the site shows 30 hits per page

/** Japanese company name -> comparable core: NFKC, legal form and punctuation removed, lower case. */
function core(name) {
  let s = (name || '').normalize('NFKC');
  s = s.replace(/\(株\)|（株）|株式会社|有限会社|合同会社|合資会社|合名会社|\(有\)|（有）/g, '');
  s = s.replace(/[\s　.,、。・･()（）\-]/g, '');
  return s.toLowerCase();
}

function cleanText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&#039;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.7' };

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let searchUrl = SEARCH_URL(keyword);
  try {
    const q = core(keyword);
    if (q.length < 2) return fail('other', searchUrl, 'name too short to match safely after removing legal form');
    searchUrl = SEARCH_URL(q);

    // 1. Full-text search of the precedent database (plain GET, server-rendered result list).
    const res = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);
    const html = await res.text();

    // Zero hits: the result block says so. Any other shape is not what we expect.
    if (/id="searched"[^>]*>\s*該当する裁判例がありませんでした/.test(html)) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'search returned 該当する裁判例がありませんでした' };
    }
    const countM = html.match(/全文検索件数:\s*(\d+)/);
    if (!countM || !html.includes('class="search-result"') || !html.includes('search-result-table')) {
      return fail('layout_changed', searchUrl, cleanText(html).slice(0, 300));
    }
    const total = parseInt(countM[1], 10);

    // 2. Hits on the first page: id and the row text (case no, name, date, court).
    const tableStart = html.indexOf('search-result-table');
    const table = html.slice(tableStart, html.indexOf('</table>', tableStart));
    const rows = table.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    const hits = [];
    for (const r of rows) {
      const m = r.match(/href="\.\/\.\.\/(\d+)\/(detail\d+)\/index\.html"/);
      if (m) hits.push({ id: m[1], detail: m[2], summary: cleanText(r).slice(0, 300), url: `${BASE}/hanrei/${m[1]}/${m[2]}/index.html` });
    }
    if (total > 0 && hits.length === 0) return fail('layout_changed', searchUrl, 'result count shown but no hit rows parsed');

    // 3. Check each hit's judgment page: does it name the company (parties line first, then the text)?
    const records = [];
    let checked = 0, unchecked = 0;
    for (let i = 0; i < hits.length; i += BATCH) {
      if (Date.now() - started > DEADLINE_MS) { unchecked = hits.length - i; break; }
      const batch = hits.slice(i, i + BATCH);
      const pages = await Promise.all(batch.map(async (h) => {
        try {
          const r = await fetch(h.url, { headers, signal: AbortSignal.timeout(25000) });
          if (!r.ok) return null;
          return { h, text: cleanText(await r.text()) };
        } catch { return null; }
      }));
      for (const p of pages) {
        if (!p) { unchecked++; continue; }
        checked++;
        const partyM = p.text.match(/当事者 (.{0,200}?) (?:主な争点|権利種別|裁判年月日|上告|裁判所名)/);
        const parties = partyM ? partyM[1] : '';
        let basis = '';
        if (parties && core(parties).includes(q)) basis = 'parties';
        else if (core(p.text).includes(q)) basis = 'body_text';
        if (basis) records.push({ summary: p.h.summary, judgment_url: p.h.url, parties, match_basis: basis });
      }
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: `${records.length} judgment(s) name ${keyword}; ${total} hits in total, ${checked} checked` };
    }
    if (total > hits.length) {
      return fail('other', searchUrl, `${total} hits, only the first ${PAGE_SIZE} were checked, none names the company`);
    }
    if (unchecked > 0) {
      return fail('timeout', searchUrl, `${unchecked} of ${hits.length} judgment pages not checked before the time budget`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `${total} hits for ${q}; none names the company in the parties line or text` };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, searchUrl, String(err?.message || err));
  }
}
