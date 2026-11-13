export const meta = { task: 'IE-enterprise-ireland.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'article_title', 'article_url', 'summary'],
  canary: { found: 'FINEOS', not_found: 'Cuideachta Ficseanach Teoranta' } };

const SEARCH = 'https://www.enterprise-ireland.com/service/search/en/4898';
const BASE = 'https://www.enterprise-ireland.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'dac', 'plc', 'teoranta', 'teo', 'unlimited', 'ulc', 'uc', 'inc', 'llc', 'gmbh']);

/** Lower-case words with accents and punctuation removed. */
function words(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/designated\s+activity\s+company/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Normalised company core: no case, punctuation, accents or legal-form words. */
function coreName(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join('');
}

/** The search text: the name as typed, minus legal-form words. */
function queryText(s) {
  const kept = (s || '').trim().split(/\s+/).filter((t) => !LEGAL.has(t.toLowerCase().replace(/[^a-z]/g, '')));
  return kept.join(' ') || (s || '').trim();
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** The part of a result title before ':' or ' - ' or '|' is the subject the article is about. */
function subjectOf(title) {
  return title.split(/\s*[:|]\s*|\s[-–—]\s/)[0].trim();
}

/** Result cards: <h4><a href>title</a></h4> followed by a short summary paragraph. */
function parseHits(html) {
  const start = html.indexOf('cm-search-results');
  const body = start >= 0 ? html.slice(start) : html;
  const re = /<h4[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h4>/g;
  const hits = [];
  let m;
  while ((m = re.exec(body))) {
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 1500);
    const sm = after.match(/<p[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/);
    hits.push({
      href: new URL(m[1].replace(/&amp;/g, '&'), BASE).href,
      title: cleanText(m[2]),
      summary: sm ? cleanText(sm[1]) : '',
    });
  }
  return hits;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${SEARCH}?query=${encodeURIComponent(queryText(keyword))}`;
  try {
    const key = coreName(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
    }

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const layoutOk = /id="cm-search-results"|cm-search__results|Your search for|0 Results for/.test(html);
    if (!layoutOk) {
      if (/captcha|cf-chl|challenge-platform|Access Denied|Request unsuccessful/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: html.slice(0, 200) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const hits = parseHits(html);
    const declared = html.match(/returned[\s\S]{0,40}?(\d+)[\s\S]{0,20}?hits/);
    const declaredCount = declared ? Number(declared[1]) : null;
    const noResults = /0 Results for/.test(html);

    if (hits.length === 0) {
      if (noResults || declaredCount === 0) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 results for "${queryText(keyword)}"` };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: `results page says ${declaredCount} hits but none could be read` };
    }

    const matched = hits.filter((h) => coreName(subjectOf(h.title)) === key);
    if (matched.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${hits.length} result(s) for "${queryText(keyword)}", none is about this company` };
    }

    return {
      status: 'found',
      reason: '',
      records: matched.map((h) => ({
        name: subjectOf(h.title),
        article_title: h.title,
        article_url: h.href,
        summary: h.summary,
      })),
      source_url: searchUrl,
      excerpt: `${matched[0].title} | ${matched[0].summary}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
