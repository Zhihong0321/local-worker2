export const meta = {
  task: 'FR-hellowork.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'company_id'],
  canary: { found: 'Carrefour', not_found: 'Zyxwvut Société Fictive SARL' },
};

// HelloWork publishes an alphabetical index of employer profiles: one list per first letter (0-9 for digits),
// paged 100 per page, sorted by name. The handler picks the letter from the name, binary-searches the pages,
// then compares the names on the candidate page and its two neighbours.
const BASE = 'https://www.hellowork.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'snc', 'sci', 'scop', 'sca', 'sel', 'selarl']);
const DEADLINE_MS = 45000; // stop well before the 60 s limit

class Fail extends Error {
  constructor(reason, excerpt, url) {
    super(excerpt);
    this.reason = reason;
    this.excerpt = excerpt;
    this.url = url;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Lower case, accents removed, punctuation removed, single spaces. Used for the site's sort order.
function sortKey(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Name for comparing company identity: legal form words removed, spaces removed.
function matchKey(s) {
  return sortKey(s)
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

function parseEntries(html) {
  const out = [];
  const re = /<a\b[^>]*?\bhref="(\/fr-fr\/entreprises\/[^"]+?-(\d+)\.html)"[^>]*?\btitle="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[3]).replace(/^Recrutement\s+/i, '').trim();
    out.push({ title, href: m[1], id: m[2] });
  }
  return out;
}

function pageUrl(letter, p) {
  return p === 1
    ? `${BASE}/fr-fr/entreprise/index-entreprises_${letter}.html`
    : `${BASE}/fr-fr/entreprise/index-entreprises_${letter}/${p}.html`;
}

async function getPage(letter, p) {
  const url = pageUrl(letter, p);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Fail(timedOut ? 'timeout' : 'other', String(e?.message || e).slice(0, 300), url);
  }
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`, url);
  if (res.status === 404) throw new Fail('layout_changed', 'HTTP 404 for an index page that should exist', url);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`, url);
  const html = await res.text();
  const entries = parseEntries(html);
  if (!entries.length) {
    if (/captcha|datadome|just a moment|verify you are human|cf-chl/i.test(html)) {
      throw new Fail('blocked', 'bot check page instead of the index', url);
    }
    throw new Fail('layout_changed', 'index page has no company entries: ' + html.replace(/\s+/g, ' ').slice(0, 200), url);
  }
  return { url, html, entries };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const sk = sortKey(name);
  const mk = matchKey(name);
  if (!mk) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl('a', 1),
             excerpt: 'the name has no Latin letters or digits to search the index by' };
  }

  const initial = sk.charAt(0);
  let letter;
  if (/[a-z]/.test(initial)) letter = initial;
  else if (/[0-9]/.test(initial)) letter = '0-9';
  else {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl('a', 1),
             excerpt: `the index has no page for the initial "${initial}"` };
  }

  let cur = null;
  try {
    const cache = new Map();
    const load = async (p) => {
      if (Date.now() - started > DEADLINE_MS) {
        throw new Fail('timeout', `stopped after ${DEADLINE_MS / 1000} s to stay under the 60 s limit`, pageUrl(letter, p));
      }
      if (!cache.has(p)) cache.set(p, await getPage(letter, p));
      return cache.get(p);
    };

    const first = await load(1);
    const pageNums = [...first.html.matchAll(new RegExp(`index-entreprises_${letter}/(\\d+)\\.html`, 'g'))]
      .map((m) => Number(m[1]));
    const total = pageNums.length ? Math.max(...pageNums) : 1;

    // Binary search for the first page whose last name is not before the keyword.
    let lo = 1;
    let hi = total;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const page = await load(mid);
      const lastKey = sortKey(page.entries[page.entries.length - 1].title);
      if (lastKey < sk) lo = mid + 1;
      else hi = mid;
    }

    const matches = new Map();
    let firstUrl = null;
    for (const p of [lo, lo + 1, lo - 1]) {
      if (p < 1 || p > total) continue;
      cur = pageUrl(letter, p);
      const page = await load(p);
      for (const e of page.entries) {
        if (matchKey(e.title) === mk && !matches.has(e.id)) {
          matches.set(e.id, { name: e.title, profile_url: BASE + e.href, company_id: e.id });
          if (!firstUrl) firstUrl = page.url;
        }
      }
    }

    if (matches.size) {
      const records = [...matches.values()];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: records.map((r) => r.name).join(' | ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl(letter, lo),
      excerpt: `index "${letter}" (${total} page${total > 1 ? 's' : ''}): no profile named "${name}"`,
    };
  } catch (e) {
    if (e instanceof Fail) {
      return { status: 'couldnt_check', reason: e.reason, records: [], source_url: e.url || cur || pageUrl(letter, 1), excerpt: e.excerpt };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: cur || pageUrl(letter, 1), excerpt: String(e?.message || e).slice(0, 300) };
  }
}
