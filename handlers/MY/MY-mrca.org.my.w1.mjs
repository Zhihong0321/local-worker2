export const meta = {
  task: 'MY-mrca.org.my',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership_type', 'category', 'website'],
  canary: { found: '7-ELEVEN MALAYSIA SDN BHD', not_found: 'Kedai Runcit Sri Bahagia Sdn Bhd' },
};

// MRCA Members Directory: a plain GET search, no token needed.
// https://mrca.org.my/memberdirectory?membersname=<term>&page=<n>   (6 members per page)
// The site matches the typed term as a literal substring of the member name (case-insensitive),
// so "7 ELEVEN" does not find "7-ELEVEN"; the handler therefore also tries the punctuation-free parts.

const BASE = 'https://mrca.org.my/memberdirectory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' };
const MAX_PAGES = 8;          // pages read per search term
const START_LIMIT_MS = 30000; // do not start a new page fetch after 30 s (each fetch has a 25 s timeout)

const LEGAL_WORDS = ['sdn', 'bhd', 'berhad'];

/** Lower case, letters and digits only (any script), legal-form words removed. Used to compare names. */
function normalize(s) {
  return (s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL_WORDS.includes(t)).join('');
}

/** The typed name without its legal-form words; other punctuation is kept because the site matches on it. */
function coreName(s) {
  return (s || '').trim().split(/\s+/)
    .filter((t) => t && !LEGAL_WORDS.includes(t.toLowerCase().replace(/[^a-z]/g, '')))
    .join(' ');
}

/** Search terms to try, in order: the core name, then the longest punctuation-free part, then the longest word. */
function searchTerms(core) {
  const terms = [core];
  const longest = (list) => list.slice().sort((a, b) => b.length - a.length)[0] || '';
  const piece = longest(core.split(/[^\p{L}\p{N}\s]+/u).map((p) => p.trim()).filter(Boolean));
  if (piece.length >= 3 && !terms.includes(piece)) terms.push(piece);
  const word = longest(core.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (word.length >= 4 && !terms.includes(word)) terms.push(word);
  return terms;
}

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function errorReason(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** One card per member: <div class="member-cards"> ... </div>. */
function parseCards(html) {
  const cards = [];
  for (const part of html.split('class="member-cards"').slice(1)) {
    const card = part.split('</div>')[0];
    const name = (card.match(/class="memdirec-name">([^<]*)</) || [])[1];
    if (!name) continue;
    cards.push({
      name: decode(name),
      membership_type: decode((card.match(/class="memdirec-rank">([^<]*)</) || [])[1]),
      category: decode((card.match(/class="memdirec-category">([^<]*)</) || [])[1]),
      website: (card.match(/<a href="([^"]+)"/) || [])[1] || '',
    });
  }
  return cards;
}

/**
 * Read the result pages of one search term.
 * Returns { matches, names, url, complete, error, cut }:
 *   complete = every result page was read (or an exact match was found);
 *   cut      = stopped because of the time limit;
 *   error    = { reason, excerpt } when the site refused or the page is not what we expect.
 */
async function searchTerm(term, keyNorm, started) {
  const matches = [];
  const names = [];
  for (let page = 1; ; page++) {
    const url = `${BASE}?membersname=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`;
    if (page > MAX_PAGES) return { matches, names, url, complete: false };
    if (Date.now() - started > START_LIMIT_MS) return { matches, names, url, complete: false, cut: true };

    let res;
    let html;
    try {
      res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      html = res.ok ? await res.text() : '';
    } catch (err) {
      return { error: { reason: errorReason(err), excerpt: String(err?.message || err).slice(0, 200) }, url };
    }
    if (res.status === 403 || res.status === 429) {
      return { error: { reason: 'blocked', excerpt: `HTTP ${res.status}` }, url };
    }
    if (!res.ok) {
      return { error: { reason: 'http_error', excerpt: `HTTP ${res.status}` }, url };
    }
    const isDirectory = html.includes('id="member-directory"');
    if (!isDirectory && /captcha|cf-chl|Just a moment|Attention Required/i.test(html)) {
      return { error: { reason: 'blocked', excerpt: 'bot check page' }, url };
    }
    if (!isDirectory) {
      return { error: { reason: 'layout_changed', excerpt: html.replace(/\s+/g, ' ').slice(0, 300) }, url };
    }

    const cards = parseCards(html);
    if (!cards.length && html.includes('memdirec-name')) {
      return { error: { reason: 'layout_changed', excerpt: 'member names found but no card could be read' }, url };
    }
    for (const c of cards) {
      names.push(c.name);
      if (normalize(c.name) === keyNorm) matches.push(c);
    }
    if (matches.length) return { matches, names, url, complete: true };
    if (!/rel="next"/.test(html)) return { matches, names, url, complete: true };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On this Windows Node build, exiting the process in the same tick as the last response body
  // aborts with a libuv assertion (exit 127). A short pause lets the connection settle first.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const typed = (keyword || '').trim();
  const core = coreName(typed);
  if (!core) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name in the input' };
  }

  const keyNorm = normalize(core);
  const terms = searchTerms(core);
  let firstUrl = '';
  let incomplete = false;
  let cut = false;

  try {
    for (const term of terms) {
      const r = await searchTerm(term, keyNorm, started);
      if (!firstUrl) firstUrl = r.url;
      if (r.error) {
        return { status: 'couldnt_check', reason: r.error.reason, records: [], source_url: r.url, excerpt: r.error.excerpt };
      }
      if (r.matches.length) {
        return {
          status: 'found',
          reason: '',
          records: r.matches,
          source_url: r.url,
          excerpt: r.matches.map((m) => `${m.name} | ${m.membership_type} | ${m.category}`).join('; ').slice(0, 500),
        };
      }
      if (!r.complete) incomplete = true;
      if (r.cut) cut = true;
    }

    const searched = terms.map((t) => `"${t}"`).join(', ');
    if (cut) {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: firstUrl, excerpt: `time limit reached while reading the directory for ${searched}` };
    }
    if (incomplete) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: `no exact match in the first ${MAX_PAGES} result pages for ${searched}; not all results read` };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `member directory search for ${searched} returned no member named "${typed}"`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl || BASE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
