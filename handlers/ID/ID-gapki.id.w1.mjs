export const meta = {
  task: 'ID-gapki.id',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'province', 'address', 'phone'],
  canary: { found: 'PT Abdi Borneo Plantations', not_found: 'PT Tidak Terdaftar Nusantara Jaya' },
};

// GAPKI member directory: https://gapki.id/member-gapki/?search=NAME
// The server renders the matching cards in the HTML (24 per page, next pages via member_page=N).
// The site search is a literal, case-insensitive substring match, so the name is sent without
// legal form and punctuation, and the cards are compared by normalised name.

const BASE = 'https://gapki.id/member-gapki/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGE_SIZE = 24;
const MAX_PAGES = 5;        // 120 results at most; more than that is couldnt_check, never not_found
const DEADLINE_MS = 45000;  // keeps the whole call well under 60 s
const LEGAL_RE = /\b(pt|cv|ud|tbk|persero|perum|kjp|kpks)\b/gi;

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;|&#0*38;|&#038;/gi, '&')
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&#0*39;|&#8217;|&rsquo;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Name as used for comparison: case, punctuation, "&" = "and", and legal form ignored.
function normalize(name) {
  return decode(name)
    .replace(/&/g, ' and ')
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_RE, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// The text sent to the site search: legal form and dots removed, spacing collapsed.
function searchTerm(keyword) {
  return decode(keyword)
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Same words with "&" and "and" swapped (the site stores "&"; people often type "and").
function altTerm(term) {
  if (term.includes('&')) return term.replace(/\s*&\s*/g, ' and ');
  if (/\band\b/i.test(term)) return term.replace(/\s*\band\b\s*/i, ' & ');
  return '';
}

// Longest word of 4+ letters: a wider search that still proves absence when read in full.
function longestWord(term) {
  const words = term.split(' ').filter((w) => w.length >= 4);
  words.sort((a, b) => b.length - a.length);
  return words[0] || '';
}

function parseCard(block) {
  const name = decode((block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]);
  if (!name) return null;
  const province = decode((block.match(/<span>Lokasi<\/span>\s*<strong>([\s\S]*?)<\/strong>/i) || [])[1]);
  const address = decode((block.match(/gapki-member-detail--address"><span>Alamat<\/span><p>([\s\S]*?)<\/p>/i) || [])[1]);
  const phone = decode((block.match(/<span>Telepon<\/span>\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1]);
  return { name, province, address, phone };
}

function fail(reason, url, excerpt) {
  return { ok: false, reason, url, excerpt };
}

async function getPage(term, page, deadline) {
  const url = new URL(BASE);
  url.searchParams.set('search', term);
  if (page > 1) url.searchParams.set('member_page', String(page));
  const href = url.href;

  if (Date.now() > deadline) return fail('timeout', href, 'stopped before the 60 s limit');

  let res;
  try {
    res = await fetch(href, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', href, String((e && e.message) || e).slice(0, 200));
  }

  if (res.status === 403 || res.status === 429) return fail('blocked', href, `HTTP ${res.status}`);
  if (!res.ok) return fail('http_error', href, `HTTP ${res.status}`);

  const html = await res.text();
  if (/cf-chl|challenge-platform|g-recaptcha|hcaptcha/i.test(html)) return fail('blocked', href, 'bot check page');

  const countM = html.match(/id="gapki-member-result-count"[^>]*>\s*([\d.,\s]+?)\s*anggota/i);
  if (!countM || !html.includes('id="gapki-member-grid"')) {
    return fail('layout_changed', href, decode(html).slice(0, 200));
  }
  const total = Number(countM[1].replace(/\D/g, ''));
  const cards = (html.match(/<article class="gapki-member-card">[\s\S]*?<\/article>/g) || [])
    .map(parseCard)
    .filter(Boolean);
  if (total > 0 && cards.length === 0) return fail('layout_changed', href, decode(html).slice(0, 200));

  return { ok: true, url: href, total, cards };
}

// Reads every page of one search (up to MAX_PAGES) and returns the cards whose normalised name matches.
async function searchAll(term, want, deadline) {
  const first = await getPage(term, 1, deadline);
  if (!first.ok) return first;
  const matchOf = (cards) => cards.filter((c) => normalize(c.name) === want);

  let matches = matchOf(first.cards);
  if (matches.length) return { ok: true, url: first.url, total: first.total, matches, complete: true };
  if (first.total === 0) return { ok: true, url: first.url, total: 0, matches: [], complete: true };

  const pages = Math.ceil(first.total / PAGE_SIZE);
  if (pages > MAX_PAGES) return { ok: true, url: first.url, total: first.total, matches: [], complete: false };

  for (let p = 2; p <= pages; p++) {
    const pg = await getPage(term, p, deadline);
    if (!pg.ok) return pg;
    matches = matchOf(pg.cards);
    if (matches.length) return { ok: true, url: pg.url, total: first.total, matches, complete: true };
  }
  return { ok: true, url: first.url, total: first.total, matches: [], complete: true };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const want = normalize(input);
    if (want.length < 2) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'name too short to search' };
    }

    const term = searchTerm(input);
    const terms = [term, altTerm(term), longestWord(term)]
      .filter((t, i, a) => t && t.length >= 2 && a.indexOf(t) === i);

    let lastUrl = BASE;
    for (const t of terms) {
      const r = await searchAll(t, want, deadline);
      if (!r.ok) {
        return { status: 'couldnt_check', reason: r.reason, records: [], source_url: r.url, excerpt: r.excerpt };
      }
      lastUrl = r.url;
      if (r.matches.length) {
        const m = r.matches[0];
        return {
          status: 'found',
          reason: '',
          records: r.matches.map((c) => ({ name: c.name, province: c.province, address: c.address, phone: c.phone })),
          source_url: r.url,
          excerpt: `GAPKI member directory: ${m.name}${m.province ? ' (' + m.province + ')' : ''}`,
        };
      }
      if (r.total > 0) {
        if (r.complete) {
          return {
            status: 'not_found',
            reason: '',
            records: [],
            source_url: r.url,
            excerpt: `${r.total} result(s) for "${t}" in the GAPKI member directory, none with this name`,
          };
        }
        return {
          status: 'couldnt_check',
          reason: 'other',
          records: [],
          source_url: r.url,
          excerpt: `${r.total} results for "${t}": more than ${MAX_PAGES * PAGE_SIZE}, not all could be read`,
        };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `0 matching members in the GAPKI member directory for "${input}"`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
