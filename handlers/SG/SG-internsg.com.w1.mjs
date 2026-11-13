export const meta = { task: 'SG-internsg.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'job_title', 'posted', 'url'],
  canary: { found: 'Pacific Refreshments Pte Ltd', not_found: '虚构科技有限公司' } };

// InternSG is a WordPress job board. Its search (?s=) is a plain GET that returns HTML; job postings are the
// only company-level data on the site, so a "record" here is one job posting by the matching employer.
const BASE = 'https://www.internsg.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const MAX_PAGES = 5;          // 10 results per page, so this checks up to 50 postings
const TIME_BUDGET_MS = 40000; // stay well under the 60 s limit
const LEGAL = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'llp', 'llc', 'inc', 'co', 'corp', 'corporation',
  'sdn', 'bhd', 'plc', 'the']);

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Name words: lower case, no punctuation, no parenthetical brand, no legal form. */
function words(s) {
  const t = decode(s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL.has(w));
}

/** Normalised company core, used to compare names. */
function core(s) {
  return words(s).join('');
}

/** A posting title looks like "Employer Name (Brand) – Job Title". The employer is the part before the first dash. */
function splitTitle(title) {
  const m = title.match(/^(.*?)\s[–—-]\s(.*)$/);
  return m ? { employer: m[1].trim(), job: m[2].trim() } : { employer: title.trim(), job: '' };
}

function fail(reason, source_url, excerpt, records = []) {
  return { status: 'couldnt_check', reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getPage(url) {
  return fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const kwWords = words(kw);
    const kwCore = kwWords.join('');
    // The site's search fails on punctuation ("PTE." breaks it), and it needs every word to appear, so search
    // for the name words only, without legal form; the title check below does the exact company match.
    const q = encodeURIComponent(kwWords.join(' '));
    const firstUrl = `${BASE}/?s=${q}`;
    if (!kwCore) return fail('other', firstUrl, 'company name has no usable characters');

    const records = [];
    let pagesRead = 0;
    let sawEnd = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? firstUrl : `${BASE}/page/${page}/?s=${q}`;
      if (page > 1 && Date.now() - started > TIME_BUDGET_MS) break;

      let res;
      try {
        res = await getPage(url);
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (records.length) break; // keep what we already have
        return fail(timedOut ? 'timeout' : 'other', url, String(err?.message || err));
      }

      // Past the last results page WordPress answers 404: the list has ended.
      if (page > 1 && res.status === 404) { sawEnd = true; break; }
      if (res.status === 403 || res.status === 429) {
        if (records.length) break;
        return fail('blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        if (records.length) break;
        return fail('http_error', url, `HTTP ${res.status}`);
      }

      const html = await res.text();
      if (!/Search Results for/i.test(html) && /cf-chl|Just a moment|g-recaptcha|h-captcha/i.test(html)) {
        if (records.length) break;
        return fail('blocked', url, 'bot check or captcha page');
      }

      const nothing = /nothing matched your search terms/i.test(html);
      const articles = html.split(/<article\b/).slice(1);
      const items = [];
      for (const a of articles) {
        const link = a.match(/<h2 class="entry-title[^"]*"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!link) continue;
        const dt = (a.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || '';
        items.push({ url: decode(link[1]), title: cleanText(link[2]), posted: dt.slice(0, 10) });
      }

      if (page === 1 && !nothing && !items.length) {
        return fail('layout_changed', url, cleanText(html).slice(0, 300));
      }
      pagesRead++;

      for (const it of items) {
        const { employer, job } = splitTitle(it.title);
        if (core(employer) === kwCore) {
          records.push({ name: employer, job_title: job, posted: it.posted, url: it.url });
        }
      }

      if (nothing || !items.length || !/class="next page-numbers"|rel="next"/.test(html)) {
        sawEnd = true;
        break;
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${records.length} job posting(s) by "${records[0].name}" on InternSG; latest: ${records[0].job_title || records[0].name} (${records[0].posted})`.slice(0, 500),
      };
    }

    if (!sawEnd) {
      // Did not reach the end of the results, so "not listed" cannot be claimed.
      return fail('other', firstUrl, `no match in the first ${pagesRead} result page(s); list not fully read`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `InternSG search returned no posting by an employer named "${kw}" (${pagesRead} result page(s) read)`,
    };
  } catch (err) {
    return fail('other', `${BASE}/?s=${encodeURIComponent(String(keyword || ''))}`, String(err?.message || err));
  }
}
