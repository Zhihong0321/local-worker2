export const meta = {
  task: 'NZ-cecc.org.nz',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'industry', 'membership_tiers', 'description'],
  canary: { found: 'Christchurch Airport', not_found: 'Pūkeko Whānau Tūturu Limited' },
};

// cecc.org.nz now 301-redirects to Business Canterbury; its member directory is the searchable list.
const BASE = 'https://www.businesscanterbury.co.nz/member-directory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 30;      // the directory shows 30 members per page
const MAX_PAGES = 5;       // at most 150 results checked
const TIME_BUDGET_MS = 30000; // do not start a new page after 30 s (each fetch is capped at 25 s)
const LEGAL = ['limited', 'ltd', 'incorporated', 'inc', 'nz', 'zealand', 'new'];

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;|&#8217;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ndash;|&mdash;|&#8211;/gi, '-');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// One word, lower-cased, without accents or punctuation (keeps letters from other scripts, e.g. Māori macrons removed).
function norm(w) {
  return String(w).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function words(s) {
  return clean(s).replace(/&/g, ' and ').split(' ').map(norm).filter(Boolean);
}

// Normalised company key: legal-form words removed from the end only ("Orion New Zealand Limited" -> "orion").
function coreKey(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL.includes(w[w.length - 1])) w.pop();
  return w.join(' ');
}

// The text sent to the site's search box: the name without trailing legal-form words.
function searchPhrase(keyword) {
  const raw = clean(keyword).replace(/&/g, ' and ').split(' ').filter(Boolean);
  while (raw.length > 1 && LEGAL.includes(norm(raw[raw.length - 1]))) raw.pop();
  return raw.join(' ') || clean(keyword);
}

function parseCards(html) {
  const parts = html.split('class="mwb-mem__card"').slice(1);
  const cards = [];
  for (const part of parts) {
    const body = part.split('mwb-mem__card-btn-wrap')[0];
    const nm = body.match(/class="mwb-mem__card-name"[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!nm) continue;
    const cat = body.match(/class="mwb-mem__card-category"[^>]*>([\s\S]*?)<\/span>/);
    const desc = body.match(/<p>([\s\S]*?)<\/p>/);
    const tiers = [...body.matchAll(/class="mwb-mem__card-tag"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => clean(m[1])).filter(Boolean);
    cards.push({
      name: clean(nm[2]),
      profile_url: new URL(decode(nm[1]), BASE).href,
      industry: cat ? clean(cat[1]) : '',
      membership_tiers: tiers,
      description: desc ? clean(desc[1]) : '',
    });
  }
  return cards;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '');
  const wantKey = coreKey(name);
  if (!wantKey) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
  }
  const phrase = searchPhrase(name);
  const urlFor = (page) => `${BASE}?search=${encodeURIComponent(phrase)}${page > 1 ? `&page=${page}` : ''}`;
  let lastUrl = urlFor(1);
  let reachedEnd = false;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > TIME_BUDGET_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: lastUrl,
          excerpt: `checked ${page - 1} result pages; stopped for the time limit` };
      }
      const url = urlFor(page);
      lastUrl = url;
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-NZ,en;q=0.9',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const cards = parseCards(html);
      const noResults = /No results found/i.test(html);

      if (cards.length === 0) {
        if (page === 1 && noResults) {
          return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: 'Sorry! No results found' };
        }
        if (page > 1 && noResults) { reachedEnd = true; break; } // ran past the last page
        if (/captcha|cf-chl|just a moment|access denied/i.test(html)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: clean(html).slice(0, 300) };
      }

      const hits = cards.filter((c) => coreKey(c.name) === wantKey);
      if (hits.length) {
        return {
          status: 'found',
          reason: '',
          records: hits,
          source_url: url,
          excerpt: hits.map((h) => `${h.name} | ${h.industry} | ${h.membership_tiers.join(', ')}`).join(' ; ').slice(0, 500),
        };
      }
      if (cards.length < PAGE_SIZE) { reachedEnd = true; break; } // last page of results, no exact match
    }

    if (reachedEnd) {
      return { status: 'not_found', reason: '', records: [], source_url: lastUrl, excerpt: 'No exact match in the search results' };
    }
    // Every page allowed was full and none matched: the list may go on, so this is not a clean not_found.
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
      excerpt: `no exact match in the first ${MAX_PAGES * PAGE_SIZE} results; not conclusive` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: lastUrl,
      excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
