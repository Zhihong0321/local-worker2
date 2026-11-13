export const meta = { task: 'MY-theedgemalaysia.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['title', 'published', 'category', 'article_url', 'summary', 'language'],
  canary: { found: 'PETRONAS Chemicals', not_found: 'Syarikat Zqxvbnm Tiada Sdn Bhd' } };

// The Edge Malaysia has no company register. Its site search (the same JSON API the search box uses) finds news
// articles, so this handler reports articles whose headline or summary names the company.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE = 'https://theedgemalaysia.com';
const LANGS = ['english', 'chinese'];
const PAGE = 10;   // the API returns 10 results per page
const PAGES = 3;   // first 30 results per language
const LEGAL = new Set(['sdn', 'bhd', 'berhad', 'pte', 'ltd', 'limited', 'plc', 'llc', 'inc']);

function tokens(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Name without case, punctuation or legal form: "ACME TRADING SDN. BHD." -> "acme trading" */
function coreName(keyword) {
  return tokens(String(keyword || '').replace(/\(\s*m\s*\)/gi, ' ')).filter((t) => !LEGAL.has(t)).join(' ');
}

/** True when the article headline or summary contains the whole name as words. */
function namesCompany(article, core) {
  const hay = ' ' + tokens(`${article.title || ''} ${article.summary || ''}`).join(' ') + ' ';
  if (hay.includes(' ' + core + ' ')) return true;
  // Chinese and other non-Latin names have no spaces between words, so compare without spaces.
  const compact = (s) => s.replace(/ /g, '');
  return /[^\u0000-\u007f]/.test(core) && compact(hay).includes(compact(core));
}

function searchUrl(core, language, offset, today) {
  return `${SITE}/api/searchOverlaymodal?offset=${offset}&from=1999-01-01&to=${today}&language=${language}&keywords=${encodeURIComponent(core)}`;
}

async function searchPage(core, language, offset, today) {
  const url = searchUrl(core, language, offset, today);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) {
      const failed = res.status === 403 || res.status === 429 ? 'blocked' : 'http_error';
      return { url, language, offset, failed, status: res.status };
    }
    let json;
    try { json = await res.json(); } catch { return { url, language, offset, failed: 'layout_changed', status: res.status }; }
    if (!json || !Array.isArray(json.results) || typeof json.total !== 'number') {
      return { url, language, offset, failed: 'layout_changed', status: res.status };
    }
    return { url, language, offset, json };
  } catch (e) {
    const failed = /abort|timeout/i.test(String(e?.name || '')) ? 'timeout' : 'other';
    return { url, language, offset, failed, status: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // Malaysia date (UTC+8)
  try {
    const core = coreName(keyword);
    const sourceUrl = searchUrl(core, LANGS[0], 0, today);
    if (core.replace(/ /g, '').length < 3) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
        excerpt: 'the name is empty or too short once the legal form is removed, so no safe search was made' };
    }

    const jobs = [];
    for (const language of LANGS) for (let i = 0; i < PAGES; i++) jobs.push(searchPage(core, language, i * PAGE, today));
    const pages = await Promise.all(jobs);
    const ok = pages.filter((p) => p.json);
    const failed = pages.filter((p) => p.failed);

    // The site answered "0 results" in every language: the company is not in the news archive.
    const zero = LANGS.every((lang) => {
      const first = pages.find((p) => p.language === lang && p.offset === 0);
      return first && first.json && first.json.total === 0;
    });
    if (zero) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `the site search returned 0 articles for "${core}" in English or Chinese` };
    }

    const seen = new Set();
    const matches = [];
    let checked = 0;
    let total = 0;
    for (const p of ok) {
      total = Math.max(total, p.json.total);
      for (const a of p.json.results) {
        if (seen.has(a.nid)) continue;
        seen.add(a.nid);
        checked++;
        if (!namesCompany(a, core)) continue;
        matches.push({
          title: a.title || '',
          published: a.created ? new Date(a.created).toISOString() : '',
          category: a.category || '',
          article_url: `${SITE}/${a.alias || 'node/' + a.nid}`,
          summary: String(a.summary || '').slice(0, 300),
          language: a.language || '',
        });
      }
    }

    if (matches.length) {
      matches.sort((x, y) => (x.published < y.published ? 1 : -1));
      return { status: 'found', reason: '', records: matches.slice(0, 25), source_url: sourceUrl,
        excerpt: `${matches.length} news article(s) name "${core}" in the headline or summary (checked ${checked} results). These are news articles, not company registry records.` };
    }

    if (failed.length) {
      const f = failed[0];
      return { status: 'couldnt_check', reason: f.failed, records: [], source_url: f.url,
        excerpt: `${failed.length} of ${pages.length} search requests failed (${f.failed}, HTTP ${f.status}${f.error ? ', ' + f.error : ''})` };
    }

    return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
      excerpt: `the site search returned ${total} articles for "${core}" but none names it in the headline or summary (checked ${checked}); absence is not proven` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl(coreName(keyword), LANGS[0], 0, today),
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
