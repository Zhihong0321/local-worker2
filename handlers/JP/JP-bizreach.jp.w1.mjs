export const meta = {
  task: 'JP-bizreach.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'job_id', 'job_url'],
  canary: { found: 'トヨタすまいるライフ株式会社', not_found: '株式会社ザクロノスフィアテスト' },
};

// BizReach publishes no company register. Each job posting shows its employer's name, so a company counts as
// "on the site" when it has at least one posting there. Keyword search matches the employer name as well.
const BASE = 'https://www.bizreach.jp';
const SEARCH = BASE + '/jobs/search/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 8;            // 20 postings per page
const START_LIMIT_MS = 25000;   // do not start another page after 25 s (each fetch has its own 25 s timeout)

const LEGAL_FORM = /株式会社|有限会社|合同会社|合資会社|合名会社/g;
const PUNCT = /[\s.,、。・･\-‐‑‒–—―()（）「」『』"'’`&]/g;

function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(LEGAL_FORM, '').replace(PUNCT, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** One results page -> { total, pages, postings } or null when the page is not the expected layout. */
function parsePage(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const count = text.match(/([\d,]+)\s*件\s*\(\s*\d+\s*ページ\/全\s*(\d+)\s*ページ\)/);
  const empty = html.includes('見つかりませんでした');
  if ((!count && !empty) || !html.includes('求人検索')) return null;

  const postings = [];
  const links = [...html.matchAll(/href="\/jobs\/(\d+)\/"/g)];
  links.forEach((m, i) => {
    const end = i + 1 < links.length ? links[i + 1].index : html.length;
    const company = html.slice(m.index, end).match(/<img alt="([^"]+)"[^>]*width="48"/);
    if (company) postings.push({ job_id: m[1], name: decode(company[1]) });
  });
  return {
    total: count ? Number(count[1].replace(/,/g, '')) : 0,
    pages: count ? Number(count[2]) : 0,
    postings,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  const wanted = normalize(input);
  const firstUrl = `${SEARCH}?keyword=${encodeURIComponent(input)}&pageNumber=1`;
  if (!wanted) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH, excerpt: 'empty company name' };
  }
  try {
    const records = [];
    const seen = new Set();
    let total = 0;
    let pages = 0;
    let page = 1;
    do {
      const url = `${SEARCH}?keyword=${encodeURIComponent(input)}&pageNumber=${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const parsed = parsePage(html);
      if (!parsed) {
        const reason = /captcha|access denied/i.test(html) ? 'blocked' : 'layout_changed';
        return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) };
      }
      if (page === 1) {
        total = parsed.total;
        pages = parsed.pages;
      }
      for (const p of parsed.postings) {
        if (normalize(p.name) === wanted && !seen.has(p.job_id)) {
          seen.add(p.job_id);
          records.push({ name: p.name, job_id: p.job_id, job_url: `${BASE}/jobs/${p.job_id}/` });
        }
      }
      page++;
    } while (page <= Math.min(pages, MAX_PAGES) && Date.now() - started < START_LIMIT_MS);

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: firstUrl,
        excerpt: `${records.length} posting(s) by ${records[0].name} on BizReach; keyword search returned ${total} postings`,
      };
    }
    if (total === 0 || page > pages) {
      return {
        status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `BizReach keyword search: ${total} postings, none by "${input}"`,
      };
    }
    if (Date.now() - started >= START_LIMIT_MS) {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: firstUrl, excerpt: `scanned ${page - 1} of ${pages} result pages in time` };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: `${total} postings in ${pages} pages; only the first ${MAX_PAGES} pages are scanned` };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: firstUrl, excerpt: String(err && err.message || err).slice(0, 300) };
  }
}
