export const meta = { task: 'JP-qiita.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'url_name', 'url', 'description'],
  canary: { found: '株式会社Hatch-IT', not_found: 'ズラクムカネスクイーズビ' } };

// Qiita organization search: https://qiita.com/organizations/search?q=<name>
// The results page carries its data as JSON inside the HTML (paginatedOrganizationSearchResult), 20 per page.
const BASE = 'https://qiita.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // exact-name hits sit on page 1 in practice; stop after 5 pages (100 organizations)
const DEADLINE_MS = 45000;    // whole call stays under 60 s
const JP_LEGAL_FORMS = ['株式会社', '有限会社', '合同会社', '合名会社', '合資会社', '相互会社'];
const EN_LEGAL_TOKENS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'kk', 'gk', 'pte', 'plc']);

/** Compare names: width, case, punctuation and legal form do not matter. */
function normalize(str) {
  let s = String(str || '').normalize('NFKC').toLowerCase();
  for (const f of JP_LEGAL_FORMS) s = s.split(f).join(' ');
  return s.split(/[^\p{L}\p{N}]+/u).filter((t) => t && !EN_LEGAL_TOKENS.has(t)).join('');
}

/** Pull the JSON object that follows "<key>": in the page, respecting strings and nesting. */
function extractJsonObject(html, key) {
  const marker = `"${key}":`;
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const begin = at + marker.length;
  if (html[begin] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = begin; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(begin, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function answer(status, reason, sourceUrl, excerpt, records = []) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const firstUrl = `${BASE}/organizations/search?q=${encodeURIComponent(String(keyword || ''))}`;
  const wanted = normalize(keyword);
  if (!wanted) return answer('couldnt_check', 'other', firstUrl, 'the company name has no letters or digits to search for');

  const started = Date.now();
  const names = [];
  const records = [];
  let totalCount = null;
  let finished = false;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) {
        return answer('couldnt_check', 'timeout', firstUrl, 'the lookup ran out of its time budget');
      }
      const url = page === 1 ? firstUrl : `${firstUrl}&page=${page}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) return answer('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return answer('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      const data = extractJsonObject(html, 'paginatedOrganizationSearchResult');
      if (!data || !Array.isArray(data.items) || !data.pageData) {
        if (/just a moment|cf-chl|challenge-platform|captcha/i.test(html.slice(0, 20000))) {
          return answer('couldnt_check', 'blocked', url, 'bot check page');
        }
        return answer('couldnt_check', 'layout_changed', url, html.slice(0, 300));
      }
      if (data.items.length && (typeof data.items[0].urlName !== 'string' || typeof data.items[0].name !== 'string')) {
        return answer('couldnt_check', 'layout_changed', url, JSON.stringify(data.items[0]).slice(0, 300));
      }

      for (const item of data.items) {
        names.push(item.name);
        if (normalize(item.name) === wanted) {
          records.push({
            name: item.name,
            url_name: item.urlName,
            url: `${BASE}/organizations/${item.urlName}`,
            description: String(item.description || '').slice(0, 300),
          });
        }
      }
      totalCount = data.pageData.totalCount;

      if (records.length) break;
      if (data.pageData.isLastPage || !data.pageData.nextPage || data.items.length === 0) { finished = true; break; }
    }

    if (records.length) {
      return answer('found', '', firstUrl,
        `Qiita organization: ${records.map((r) => `${r.name} (${r.url})`).join('; ')}`, records);
    }
    if (finished && names.length === 0) {
      return answer('not_found', '', firstUrl, `Qiita organization search "${keyword}": 0 results`);
    }
    if (finished) {
      // The site returned related organizations but none with this exact name (e.g. a brand name instead of the
      // legal name). That does not prove the company is absent, so it is not reported as not_found.
      return answer('couldnt_check', 'other', firstUrl,
        `related organizations returned but none with the same normalised name: ${names.slice(0, 5).join(' | ')}`);
    }
    return answer('couldnt_check', 'other', firstUrl,
      `no exact match in the first ${MAX_PAGES} pages of ${totalCount} results; the name may be further down`);
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return answer('couldnt_check', reason, firstUrl, String(err && err.message ? err.message : err));
  }
}
