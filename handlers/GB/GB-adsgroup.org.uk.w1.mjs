export const meta = {
  task: 'GB-adsgroup.org.uk', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'location', 'website', 'profile_url'],
  canary: { found: 'Angoka Ltd', not_found: 'Zorvantis Quillfeather Holdings Ltd' },
};

// ADS Group publishes its members as an alphabetical list: /members/<letter>/ (and /members/0-9/ for names that start
// with a digit or a symbol), 16 companies per page, with the total in "of N member companies". The handler reads the
// letter list for the company name, reads every page of it, and compares normalised names.

const BASE = 'https://www.adsgroup.org.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGE_SIZE = 16;
const BATCH = 4;            // pages fetched at the same time
const BUDGET_MS = 50000;    // stop scanning before the 60 s limit
const LEGAL_FORMS = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'llc', 'inc', 'co', 'cic']);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function foldAccents(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Case, accents, punctuation, spacing and a trailing legal form do not count. "&" is read as "and". */
function normalizeName(s) {
  const tokens = foldAccents(decodeEntities(s)).toLowerCase().replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

/** Letter list for the name: its first letter, or 0-9 when it starts with a digit or a symbol (the site files "&Partners IT Ltd" under 0-9). */
function listingLetter(keyword) {
  const first = foldAccents(keyword.trim()).charAt(0).toLowerCase();
  return /^[a-z]$/.test(first) ? first : '0-9';
}

function pageUrl(letter, page) {
  return page === 1 ? `${BASE}/members/${letter}/` : `${BASE}/members/${letter}/page/${page}/`;
}

async function getPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) }, url };
  }
  if (res.status === 403 || res.status === 429) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', excerpt: `HTTP ${res.status}` }, url };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', excerpt: `HTTP ${res.status}` }, url };
  }
  const html = await res.text();
  if (/captcha|cf-chl|just a moment/i.test(html.slice(0, 5000))) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', excerpt: 'bot check page' }, url };
  }
  return { html, url };
}

/** Reads the company cards of one list page. */
function parseCards(html) {
  const cards = [];
  const h5Re = /<h5><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h5>/g;
  let m;
  while ((m = h5Re.exec(html)) !== null) {
    const rest = html.slice(m.index, m.index + 1500);
    const loc = rest.match(/<p class="location[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const web = rest.match(/<p class="website[^"]*"[^>]*>\s*<a href="([^"]+)"/);
    cards.push({
      name: stripTags(m[2]),
      profile_url: m[1].replace(/\/\/$/, '/'),
      location: loc ? stripTags(loc[1]) : '',
      website: web ? web[1] : '',
    });
  }
  return cards;
}

function totalFrom(html) {
  const m = html.match(/of\s+(\d+)\s+member compan/i);
  return m ? Number(m[1]) : null;
}

async function lookupInner(keyword) {
  const started = Date.now();
  const letter = listingLetter(String(keyword || ''));
  const firstUrl = pageUrl(letter, 1);
  try {
    const kwNorm = normalizeName(String(keyword || ''));
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
    }

    const first = await getPage(firstUrl);
    if (first.fail) return { ...first.fail, records: [], source_url: first.url };

    const total = totalFrom(first.html);
    const firstCards = parseCards(first.html);
    if (total === null || firstCards.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl,
        excerpt: first.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) };
    }

    const pages = Math.ceil(total / PAGE_SIZE);
    const pageNos = [];
    for (let p = 2; p <= pages; p++) pageNos.push(p);

    const scanned = [{ url: firstUrl, cards: firstCards }];
    for (let i = 0; i < pageNos.length; i += BATCH) {
      if (Date.now() - started > BUDGET_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: pageUrl(letter, pageNos[i]),
          excerpt: `scanned ${scanned.length} of ${pages} pages of letter ${letter}` };
      }
      const batch = pageNos.slice(i, i + BATCH).map((p) => getPage(pageUrl(letter, p)));
      const results = await Promise.all(batch);
      for (const r of results) {
        if (r.fail) return { ...r.fail, records: [], source_url: r.url };
        const cards = parseCards(r.html);
        if (cards.length === 0) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: r.url,
            excerpt: 'list page without company cards' };
        }
        scanned.push({ url: r.url, cards });
      }
    }

    const listed = scanned.reduce((n, s) => n + s.cards.length, 0);
    const records = [];
    const seen = new Set();
    for (const s of scanned) {
      for (const c of s.cards) {
        if (normalizeName(c.name) !== kwNorm || seen.has(c.profile_url)) continue;
        seen.add(c.profile_url);
        records.push({ name: c.name, location: c.location, website: c.website, profile_url: c.profile_url });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `checked all ${listed} members listed under "${letter}" (${scanned.length} pages): no name match`,
      };
    }
    return {
      status: 'found', reason: '', records,
      source_url: records[0].profile_url,
      excerpt: records.map((r) => `${r.name}${r.location ? ' - ' + r.location : ''}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupInner(keyword);
  await new Promise((r) => setTimeout(r, 1500)); // let the keep-alive sockets settle before the runner exits
  return result;
}
