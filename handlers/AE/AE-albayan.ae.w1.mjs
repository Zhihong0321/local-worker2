export const meta = { task: 'AE-albayan.ae', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['title', 'publish_time', 'section', 'byline', 'url', 'article_id', 'matched_in'],
  canary: { found: 'دي بي ورلد', not_found: 'زعفران الكواكب الزرقاء للتجارة' } };

const SITE = 'https://www.albayan.ae';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL_LETTERS = new Set(['ش', 'ذ', 'م', 'ع', 'خ', 'و', 'ح']);
const LEGAL_WORDS = new Set(['شركة', 'مؤسسة']);

/** Name without the legal form (ش.م.ع, ش.ذ.م.م, شركة ...), original letters kept. */
function stripLegal(raw) {
  const tokens = String(raw || '').replace(/[.\-_,،]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_LETTERS.has(tokens[tokens.length - 1])) tokens.pop();
  while (tokens.length > 1 && LEGAL_WORDS.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

/** Normalised form for comparing names: no harakat, alef/yaa/taa-marbuta unified, punctuation to spaces. */
function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function htmlToText(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}

function containsPhrase(hay, needle) {
  return needle !== '' && (` ${hay} `).includes(` ${needle} `);
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const raw = String(keyword ?? '').trim();
  const core = stripLegal(raw);
  const searchUrl = `${SITE}/search/${encodeURIComponent(core || raw)}`;
  try {
    if (!/[؀-ۿ]/.test(raw)) {
      return couldnt('other', searchUrl, 'Al Bayan is an Arabic-language site; this name has no Arabic letters, so its search cannot match it.');
    }
    const needle = norm(core);
    if (!needle) return couldnt('other', searchUrl, 'Empty name after removing the legal form.');

    const res = await fetch(searchUrl, {
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.8',
      },
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return couldnt('layout_changed', searchUrl, html.slice(0, 300));
    let pp;
    try { pp = JSON.parse(m[1]).props.pageProps; } catch (e) { return couldnt('layout_changed', searchUrl, 'embedded data is not JSON'); }
    if (pp && pp.error) return couldnt('other', searchUrl, `site search error: ${String(pp.error).slice(0, 200)}`);
    const sr = pp && pp.searchResults;
    if (sr && sr.response === 'failed') {
      // The site's empty-result answer: HTTP 200, search page rendered, no error text, no articles.
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `Search answered normally with response "failed" and no articles for "${core}" (empty result)` };
    }
    if (!sr || !Array.isArray(sr.articles_data)) return couldnt('layout_changed', searchUrl, 'no searchResults.articles_data in the page');

    const articles = sr.articles_data;
    const total = Number(sr.total) || 0;
    if (articles.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `Search returned 0 articles for "${core}"` };
    }

    const records = [];
    for (const a of articles) {
      const title = a.article_title || '';
      const headTxt = norm(`${title} ${a.article_headline || ''} ${a.article_subtitle || ''}`);
      const bodyTxt = norm(`${htmlToText(a.article_body)} ${a.article_tags || ''} ${a.seo_meta_description || ''}`);
      let matched_in = null;
      if (containsPhrase(headTxt, needle)) matched_in = 'title';
      else if (containsPhrase(bodyTxt, needle)) matched_in = 'body';
      if (matched_in) {
        records.push({
          title,
          publish_time: a.publish_time || '',
          section: a.section_info || a.section_name || '',
          byline: a.article_byline || a.author_name || '',
          url: a.permalink ? `${SITE}/${a.permalink}` : '',
          article_id: String(a.cms_article_id || ''),
          matched_in,
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `Checked the first ${articles.length} of ${total} search results; none contains the name "${core}"`,
      };
    }
    return {
      status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: `${records.length} article(s) on page 1 of search results contain "${core}". First: ${records[0].title}`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', searchUrl, String(err && err.message || err).slice(0, 300));
  }
}
