export const meta = {
  task: 'JP-en-hyoban.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'site_company_url', 'site_company_id', 'address', 'industry', 'review_count', 'rating', 'avg_salary_man_yen', 'avg_overtime_hours'],
  canary: { found: 'トヨタ自動車株式会社', not_found: 'ゼロヒット架空株式会社' },
};

// Site: エン カイシャの評判 (formerly Lighthouse), https://en-hyouban.com
// Search: GET /search/?SearchWords=<name>&page=<n>, 30 results per page, company cards rendered in the HTML.
// "全 <span class="total">N</span> 件" is the result count; 0 means no company matches the search.

const SITE = 'https://en-hyouban.com';
const SEARCH = `${SITE}/search/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 30;
const MAX_PAGES = 10;                    // at most 300 results are read per search
const START_NEXT_PAGE_BEFORE_MS = 30000; // keeps the whole call under 60 s (each fetch has a 25 s timeout)

const JAPANESE = /[々〇぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;
const LEGAL_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社/g;

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Compare company names: width and case folded, legal form removed (株式会社 / (株) / ㈱ ...), punctuation and spaces removed.
function normalize(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\((株|有|合|同|資|名|相)\)/g, '')
    .replace(LEGAL_FORMS, '')
    .replace(/[\s()[\]・.,&\-'"’]/g, '');
}

// The name without its legal form, for the site's search (it finds 0 for 株式会社トヨタ自動車 but finds トヨタ自動車).
function coreName(s) {
  return (s || '').normalize('NFKC').replace(/\((株|有|合|同|資|名|相)\)/g, '').replace(LEGAL_FORMS, '').replace(/\s+/g, ' ').trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function parseCard(part) {
  const a = part.match(/<a href="(https:\/\/en-hyouban\.com\/company\/([^"/]+)\/?)" class="company_name_anchor">([\s\S]*?)<\/a>/);
  if (!a) return null;
  const addressHtml = (part.match(/<div class="address">([\s\S]*?)<\/div>/) || [])[1] || '';
  const industryHtml = (part.match(/<div class="internet">([\s\S]*?)<\/div>/) || [])[1] || '';
  const rating = (part.match(/class="star-score">\s*([\d.]+)/) || [])[1] || '';
  const reviews = (part.match(/口コミ<span[^>]*>\s*([\d,]+)\s*<\/span>/) || [])[1] || '';
  const salary = (part.match(/平均年収<\/h3>\s*<span[^>]*>\s*([^<]*?)\s*<\/span>/) || [])[1] || '';
  const overtime = (part.match(/残業時間\(月間\)<\/h3>\s*<span[^>]*>\s*([^<]*?)\s*<\/span>/) || [])[1] || '';
  const num = (v) => (v && /\d/.test(v) ? Number(v.replace(/,/g, '')) : null);
  const name = cleanText(a[3]);
  const address = cleanText(addressHtml);
  const industry = cleanText(industryHtml);
  return {
    name,
    site_company_url: a[1],
    site_company_id: a[2],
    address,
    industry,
    review_count: num(reviews),
    rating: num(rating),
    avg_salary_man_yen: num(salary),
    avg_overtime_hours: num(overtime),
    excerpt: [name, address, industry, reviews ? `口コミ ${reviews}件` : '', salary ? `平均年収 ${salary}万円` : '']
      .filter(Boolean).join(' | '),
  };
}

function parseCards(html) {
  const parts = html.split('class="card direct-chat direct-chat-primary result-item');
  const cards = [];
  for (const part of parts.slice(1)) {
    const card = parseCard(part.slice(0, 8000));
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * Runs the site search for one query and reads its result pages until the name is found or the results run out.
 * Returns { stop: <couldnt_check answer> } when the site could not be read, otherwise
 * { matches, total, pagesRead, lastUrl } where total is the site's own count of results.
 */
async function searchSite(query, wanted, started) {
  const searchUrl = (page) => `${SEARCH}?SearchWords=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ''}`;
  const matches = [];
  let total = null;
  let pagesRead = 0;
  let lastUrl = searchUrl(1);

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && Date.now() - started > START_NEXT_PAGE_BEFORE_MS) {
      return { stop: couldnt('timeout', lastUrl, `stopped before page ${page} to stay under 60 s`) };
    }
    const url = searchUrl(page);
    lastUrl = url;

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.5' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { stop: couldnt(timedOut ? 'timeout' : 'other', url, String(err && err.message || err)) };
    }

    if (res.status === 403 || res.status === 429) {
      return { stop: couldnt('blocked', url, `HTTP ${res.status}`) };
    }
    if (!res.ok) {
      return { stop: couldnt('http_error', url, `HTTP ${res.status}`) };
    }

    const html = await res.text();
    const totalMatch = html.match(/全 <span class="total">\s*(\d+)\s*<\/span>/);
    if (!totalMatch) {
      if (/captcha|challenge-platform|Just a moment|アクセスが制限/i.test(html)) {
        return { stop: couldnt('blocked', url, 'bot check or access limit page') };
      }
      return { stop: couldnt('layout_changed', url, cleanText(html)) };
    }
    total = Number(totalMatch[1]);
    pagesRead = page;

    if (total === 0) break; // the site's own "no results" answer

    const cards = parseCards(html);
    if (cards.length === 0) {
      return { stop: couldnt('layout_changed', url, `total ${total} but no company cards: ${cleanText(html)}`) };
    }

    for (const card of cards) {
      if (normalize(card.name) === wanted) matches.push({ ...card, source_url: url });
    }
    if (matches.length > 0) break;
    if (page * PAGE_SIZE >= total) break;
  }

  return { matches, total, pagesRead, lastUrl };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const wanted = normalize(kw);
    if (!wanted) {
      return couldnt('other', SEARCH, 'empty company name');
    }
    // The site lists companies in Japanese only. A Latin-script name gets 0 results even when the company
    // exists, so that answer would be a false not_found. It cannot be checked here.
    if (!JAPANESE.test(kw)) {
      return couldnt('other', SEARCH, 'the site lists companies in Japanese only; the name has no Japanese characters, so it cannot be checked here');
    }

    // First the name as typed; then, if it has a legal form that the site search does not match, the bare name.
    const queries = [kw];
    const core = coreName(kw);
    if (core && core !== kw && JAPANESE.test(core)) queries.push(core);

    const found = [];
    const reads = [];
    for (const query of queries) {
      const r = await searchSite(query, wanted, started);
      if (r.stop) return r.stop;
      found.push(...r.matches);
      reads.push(r);
      if (found.length > 0) break;
    }

    if (found.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: found.map(({ excerpt, source_url, ...record }) => record),
        source_url: found[0].source_url,
        excerpt: found[0].excerpt,
      };
    }

    // Not found: only a conclusive "no" if every search read all of its results.
    for (const r of reads) {
      if (r.total !== null && r.total > r.pagesRead * PAGE_SIZE) {
        return couldnt('other', r.lastUrl, `${r.total} results; the first ${r.pagesRead * PAGE_SIZE} do not include this name`);
      }
    }
    const last = reads[reads.length - 1];
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: last.lastUrl,
      excerpt: `全 ${last.total} 件: none of the results is this company`,
    };
  } catch (err) {
    return couldnt('other', SEARCH, String(err && err.message || err));
  }
}
