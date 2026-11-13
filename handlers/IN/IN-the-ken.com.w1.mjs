export const meta = {
  task: 'IN-the-ken.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['company', 'title', 'author', 'summary', 'url'],
  canary: { found: 'Tata Sons', not_found: 'नकली कंपनी प्राइवेट लिमिटेड' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COMPANY_URL = 'https://the-ken.com/company/?q=';

// Legal-form words (English and Hindi). Removed before the query, so "TATA SONS PRIVATE LIMITED" looks up "Tata Sons".
const LEGAL_WORDS = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'plc', 'opc', 'corp', 'corporation',
  'प्राइवेट', 'प्रा', 'लिमिटेड', 'लि',
]);

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function stripLegalForm(name) {
  return (name || '')
    .split(/[\s,]+/)
    .filter((t) => t && !LEGAL_WORDS.has(normalize(t)))
    .join(' ')
    .trim();
}

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = (tag || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : '';
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Fetch the company tag page for one query and read its heading and article list. */
async function readCompanyPage(query) {
  const url = COMPANY_URL + encodeURIComponent(query);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { error: timedOut ? 'timeout' : 'other', url, excerpt: String(err?.message || err) };
  }
  if (res.status === 403 || res.status === 429) return { error: 'blocked', url, excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { error: 'http_error', url, excerpt: `HTTP ${res.status}` };

  const html = await res.text();
  const headingMatch = html.match(/<h2[^>]*search-result-item-title[^>]*>([\s\S]*?)<\/h2>/i);
  if (!headingMatch) {
    if (/captcha|cf-chl|Just a moment|Attention Required|Access denied/i.test(html)) {
      return { error: 'blocked', url, excerpt: cleanText(html).slice(0, 300) };
    }
    return { error: 'layout_changed', url, excerpt: cleanText(html).slice(0, 300) };
  }
  const heading = cleanText(headingMatch[1]).replace(/^Company\s*:\s*/i, '').trim();

  const start = html.indexOf('id="tag-result"');
  if (start < 0) return { error: 'layout_changed', url, excerpt: 'no tag-result section' };
  const section = html.slice(start);

  const articles = [];
  const seen = new Set();
  for (const block of section.match(/<article[\s\S]*?<\/article>/gi) || []) {
    const anchors = block.match(/<a\b[^>]*>/gi) || [];
    const link = anchors.find((a) => /class="[^"]*\barticle-link\b/i.test(a));
    const articleUrl = link ? attr(link, 'href') : '';
    const title = cleanText((block.match(/<h2[^>]*medium-title-m[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]);
    if (!articleUrl || !title || seen.has(articleUrl)) continue;
    seen.add(articleUrl);
    articles.push({
      company: heading,
      title,
      author: cleanText((block.match(/<h5[^>]*author-byline[^>]*>([\s\S]*?)<\/h5>/i) || [])[1]),
      summary: cleanText((block.match(/<p[^>]*tag-paragraph[^>]*>([\s\S]*?)<\/p>/i) || [])[1]),
      url: articleUrl,
    });
  }
  return { heading, articles, url, excerpt: `${articles.length} articles tagged "${heading}"` };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  // Let the sockets of the last fetch close before the worker process exits (Windows Node 24 aborts on an exit race otherwise).
  await new Promise((resolve) => setTimeout(resolve, 500));
  return result;
}

async function lookupOnce(keyword) {
  try {
    const typed = (keyword || '').replace(/\s+/g, ' ').trim();
    if (!typed) return couldnt('other', COMPANY_URL, 'empty company name');

    const stripped = stripLegalForm(typed) || typed;
    const queries = [stripped];
    if (normalize(typed) !== normalize(stripped)) queries.push(typed);

    let lastUrl = COMPANY_URL + encodeURIComponent(stripped);
    let lastHeading = '';
    for (const query of queries) {
      const page = await readCompanyPage(query);
      if (page.error) return couldnt(page.error, page.url, page.excerpt);
      lastUrl = page.url;
      lastHeading = page.heading;

      // The page echoes the company name it was asked for; it must be the same company, not a similar word.
      if (normalize(page.heading) !== normalize(query)) {
        return couldnt('layout_changed', page.url, `heading "${page.heading}" does not match query "${query}"`);
      }
      if (page.articles.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: page.articles,
          source_url: page.url,
          excerpt: `${page.articles.length} articles tagged "${page.heading}" on The Ken. First: ${page.articles[0].title}`.slice(0, 500),
        };
      }
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `No articles tagged "${lastHeading || stripped}" on The Ken`,
    };
  } catch (err) {
    return couldnt('other', COMPANY_URL, String(err?.message || err));
  }
}
