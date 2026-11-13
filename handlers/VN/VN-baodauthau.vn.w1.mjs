// Báo Đấu Thầu (baodauthau.vn) has no company register. Its public search (the same API the site's
// "Tìm kiếm" box calls) returns news articles. A company counts as found when its name appears in the
// headline or lead (sapo) of an article. Limits: the search total is unreliable (it reports ~1000 for
// nonsense names), so only the first pages of results are read; a name that appears only deep in an
// article body is not seen.

export const meta = {
  task: 'VN-baodauthau.vn',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['title', 'published', 'url', 'lead', 'matched_on'],
  canary: { found: 'Tập đoàn Đèo Cả', not_found: 'Công ty TNHH Xyzzy Qwerty Vô Danh' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Referer': 'https://baodauthau.vn/',
};
const SITE = 'https://baodauthau.vn';
const SEARCH_API = 'https://api.baodauthau.vn/api/morenews-search-0-';
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const DEADLINE_MS = 30000; // do not start a new page after 30 s, so the whole call stays under 60 s

/** Lower-case ASCII, no diacritics, punctuation to single spaces. */
function fold(s) {
  return (s || '')
    .replace(/đ|Đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Remove legal-form words from the start and end of a folded name, repeatedly. */
function stripLegalForm(s) {
  const lead = [/^cong ty\s+/, /^(tnhh|cp|co phan|trach nhiem huu han|mot thanh vien|mtv|tm|dv)\s+/];
  const tail = [/\s(jsc|mtv|tnhh|cp|ltd|co ltd|sdn bhd|bhd|pte ltd|company limited|limited)$/, /\s(mot thanh vien)$/];
  let prev = null;
  while (prev !== s) {
    prev = s;
    for (const re of lead) s = s.replace(re, '');
    for (const re of tail) s = s.replace(re, '');
    s = s.trim();
  }
  return s;
}

/** Returns the query to send and the folded phrases to look for in headlines and leads. */
function nameForms(keyword) {
  const core = stripLegalForm(fold(keyword));
  const candidates = [];
  if (core.length >= 3) candidates.push(core);
  // "Tập đoàn X" / "Tổng công ty X" is often written as just "X" in headlines
  const short = core.replace(/^(tap doan|tong cong ty|tong cty)\s+/, '');
  if (short !== core && short.length >= 5) candidates.push(short);
  return { query: candidates.length ? candidates[candidates.length - 1] : '', candidates };
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, n) => (+n <= 0x10ffff ? String.fromCodePoint(+n) : ' '))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : ' '))
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (res.status === 403 || res.status === 429) return { err: 'blocked', detail: `HTTP ${res.status}` };
  if (!res.ok) return { err: 'http_error', detail: `HTTP ${res.status}` };
  const text = await res.text();
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { err: 'layout_changed', detail: text.slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const { query, candidates } = nameForms(name);
  const sourceUrl = `${SITE}/tim-kiem/?q=${encodeURIComponent(query || name)}`;
  try {
    if (!candidates.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
        excerpt: 'name has no usable words after removing the legal form' };
    }

    const records = [];
    const seenUrls = new Set();
    let scanned = 0;
    let pagesRead = 0;
    let total = null;
    let partial = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > DEADLINE_MS) break;
      const r = await getJson(`${SEARCH_API}${page}.html?phrase=${encodeURIComponent(query)}`);
      if (r.err) {
        if (page === 1) return { status: 'couldnt_check', reason: r.err, records: [], source_url: sourceUrl, excerpt: r.detail };
        partial = { err: r.err, detail: `page ${page}: ${r.detail}` };
        break;
      }
      if (r.json && r.json.data === null && r.json.error_code === -404) {
        // the site's own answer for an empty search ("Không tìm thấy dữ liệu" = no data found)
        if (page === 1) total = 0;
        break;
      }
      const data = r.json && r.json.data;
      if (!data || !Array.isArray(data.contents)) {
        const detail = JSON.stringify(r.json).slice(0, 200);
        if (page === 1) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: detail };
        partial = { err: 'layout_changed', detail: `page ${page}: ${detail}` };
        break;
      }
      if (page === 1) total = data.total;
      pagesRead = page;
      if (data.contents.length === 0) break;

      for (const item of data.contents) {
        scanned++;
        const title = cleanText(item.title);
        const lead = cleanText(item.description);
        const inTitle = candidates.some((c) => ` ${fold(title)} `.includes(` ${c} `));
        const inLead = candidates.some((c) => ` ${fold(lead)} `.includes(` ${c} `));
        if (!inTitle && !inLead) continue;
        const url = new URL(item.url || `/${item.content_id}`, SITE).href;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        records.push({
          title,
          published: item.date ? new Date(item.date * 1000).toISOString().slice(0, 10) : '',
          url,
          lead: lead.slice(0, 300),
          matched_on: inTitle ? 'title' : 'lead',
        });
      }
      if (data.contents.length < PAGE_SIZE) break; // last page of results
    }

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: sourceUrl,
        excerpt: `${records.length} article(s) name "${name}" in the headline or lead; ${scanned} results read on ${pagesRead} page(s)`,
      };
    }
    if (partial) {
      return { status: 'couldnt_check', reason: partial.err, records: [], source_url: sourceUrl,
        excerpt: `no match in ${scanned} results read, then ${partial.detail}` };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: sourceUrl,
      excerpt: `0 of ${scanned} search results name "${name}" in the headline or lead (site search total ${total})`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: sourceUrl,
      excerpt: String(err && err.message || err).slice(0, 300),
    };
  }
}
