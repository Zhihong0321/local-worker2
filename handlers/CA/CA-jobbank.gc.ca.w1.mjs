export const meta = {
  task: 'CA-jobbank.gc.ca',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'job_title', 'location', 'posted', 'job_source', 'job_url', 'job_id'],
  canary: { found: 'LETTRAGE CRÉATION ES INC.', not_found: 'Entreprise Fantôme Zqxv Ltée' },
};

// Job Bank lists employers only through their job postings. The handler runs a quoted phrase search for the
// company name, then keeps only the postings whose employer name matches the company (legal form and "The" ignored).

const BASE = 'https://www.jobbank.gc.ca';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'ltd', 'ltee', 'limited', 'corp', 'corporation', 'co', 'company',
  'llc', 'llp', 'lp', 'ulc', 'senc', 'sencrl', 'enr', 'cie', 'compagnie', 'sec', 'societe']);

/** Lower case, accents removed, letters and digits only: used to compare names. */
function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The words of a company name as typed (accents kept), without dots, trailing legal form or leading "the". */
function coreWords(name) {
  const words = String(name || '').replace(/\./g, '').replace(/"/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && LEGAL.has(fold(words[words.length - 1]))) words.pop();
  while (words.length > 1 && fold(words[0]) === 'the') words.shift();
  return words;
}

function decode(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** One object per job posting on the results page. */
function parsePostings(html) {
  return html
    .split(/<article\s+id="article-/)
    .slice(1)
    .filter((chunk) => chunk.includes('resultJobItem'))
    .map((c) => {
      const href = ((c.match(/<a href="(\/jobsearch\/jobposting\/[^"]*)"/) || [])[1] || '').replace(/;jsessionid=[^?"]*/, '');
      return {
        business: clean((c.match(/<li class="business">([\s\S]*?)<\/li>/) || [])[1]),
        job_title: clean((c.match(/<span class="noctitle">([\s\S]*?)<\/span>/) || [])[1]),
        location: clean((c.match(/<li class="location">([\s\S]*?)<\/li>/) || [])[1]).replace(/^Location\s*/i, ''),
        posted: clean((c.match(/<li class="date">([\s\S]*?)<\/li>/) || [])[1]),
        job_source: clean((c.match(/<span class="job-source[^"]*"><span class="wb-inv">([\s\S]*?)<\/span>/) || [])[1]),
        job_url: href ? new URL(decode(href), BASE).href : '',
        job_id: (href.match(/jobposting\/(\d+)/) || [])[1] || '',
      };
    });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const words = coreWords(keyword);
  const key = fold(words.join(' '));
  if (!key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no usable words in the company name' };
  }
  const phrase = words.join(' ');
  const searchUrl = `${BASE}/jobsearch/jobsearch?searchstring=${encodeURIComponent('"' + phrase + '"')}&locationstring=`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const countMatch = html.match(/id="results-count">\s*([\d,]+)/);
    if (!countMatch) {
      if (/captcha|access denied|request rejected|incapsula|are you a robot/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: html.slice(0, 300) };
    }

    const total = Number(countMatch[1].replace(/,/g, ''));
    const postings = parsePostings(html);
    const matched = postings.filter((p) => p.business && fold(coreWords(p.business).join(' ')) === key);

    if (matched.length) {
      return {
        status: 'found',
        reason: '',
        records: matched.map(({ business, job_title, location, posted, job_source, job_url, job_id }) => ({
          name: business, job_title, location, posted, job_source, job_url, job_id,
        })),
        source_url: searchUrl,
        excerpt: `${matched.length} job posting(s) by ${matched[0].business} among ${total} results for "${phrase}"`,
      };
    }

    if (total > postings.length) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: searchUrl,
        excerpt: `${total} results for "${phrase}"; only the first ${postings.length} were read and none is by this employer`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `${total} results for "${phrase}", none posted by this employer`,
    };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl, excerpt: 'no answer within 25 s' };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
