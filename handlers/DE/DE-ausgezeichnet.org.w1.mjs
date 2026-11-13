export const meta = {
  task: 'DE-ausgezeichnet.org',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'domain', 'rating', 'reviews_count', 'profile_url'],
  canary: { found: 'Zahnarzt Selters Westerwald', not_found: 'Schreinerei Zwiebelmann Nordpol GmbH' },
};

const BASE = 'https://www.ausgezeichnet.org/branchen/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
};
const PER_PAGE = 20;             // the site shows 20 companies per page (ei-page=N)
const MAX_PAGES = 10;            // at most 200 results are read for one name
const SOFT_DEADLINE_MS = 30000;  // no new result page after this; the whole call must end under 60 s
const CHALLENGE = /captcha|just a moment|cf-challenge|attention required/i;

// Legal-form words, as they look after fold() and removal of punctuation
const LEGAL = new Set(['gmbh', 'mbh', 'ug', 'ag', 'kg', 'ohg', 'gbr', 'kgaa', 'ek', 'ev', 'eg', 'se', 'co', 'ltd', 'limited', 'inc', 'llc', 'haftungsbeschrankt']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (Object.prototype.hasOwnProperty.call(ENTITIES, n) ? ENTITIES[n] : m));
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// lower case, umlauts and sharp s spelled out, accents removed
function fold(s) {
  return String(s || '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/\p{M}/gu, '');
}

// one word reduced to letters and digits (punctuation dropped)
function wordKey(w) {
  return fold(w).replace(/[^\p{L}\p{N}]/gu, '');
}

// The company name without its legal form, as text the site search can match (the site matches part of the name).
function searchText(name) {
  const kept = [];
  for (const w of String(name || '').trim().split(/\s+/).filter(Boolean)) {
    const k = wordKey(w);
    if (LEGAL.has(k)) continue;
    kept.push({ w, punct: k === '' });
  }
  while (kept.length && kept[0].punct) kept.shift();
  while (kept.length && kept[kept.length - 1].punct) kept.pop();
  return kept.map((x) => x.w).join(' ');
}

function pageUrl(text, page) {
  const u = new URL(BASE);
  u.searchParams.set('query', text);
  if (page > 1) u.searchParams.set('ei-page', String(page));
  return u.href;
}

/** Reads one result page. Returns null when the page is not the layout this handler knows. */
function parsePage(html) {
  const tab = html.match(/Unternehmen \((\d+)\)/);
  if (!tab || !html.includes('Suchergebnisse für')) return null;
  const total = Number(tab[1]);
  const cards = [];
  for (const chunk of html.split(/<article class="ei-company[^"]*">/).slice(1)) {
    const body = chunk.split('</article>')[0];
    const nameM = body.match(/<h3 class="ei-company__name">([\s\S]*?)<\/h3>/);
    if (!nameM) return null;
    const facts = body.match(/<ul class="ei-company__facts">([\s\S]*?)<\/ul>/);
    const items = facts ? (facts[1].match(/<li[^>]*>[\s\S]*?<\/li>/g) || []) : [];
    const link = items.find((li) => /<a\s/.test(li));
    const address = items.find((li) => !/<a\s/.test(li));
    const meta = body.match(/<div class="ei-company__meta">([\s\S]*?)<\/div>/);
    const value = body.match(/<span class="ei-company__value">([\s\S]*?)<\/span>/);
    const profile = body.match(/<a class="ei-btn ei-btn--outline" href="([^"]+)"/);
    const reviews = meta ? clean(meta[1]).match(/([\d.]+)\s*Bewertung/) : null;
    cards.push({
      name: clean(nameM[1]),
      address: clean(address || ''),
      domain: clean(link || ''),
      rating: clean(value ? value[1] : ''),
      reviews_count: reviews ? reviews[1] : '',
      profile_url: profile ? decode(profile[1]) : '',
    });
  }
  return { total, cards };
}

function isTimeout(e) {
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let firstUrl = BASE;
  try {
    const text = searchText(keyword);
    const target = wordKey(text);
    if (target.length < 2) return fail('other', BASE, `no searchable name in "${keyword}"`);
    firstUrl = pageUrl(text, 1);

    const matches = [];
    let total = 0;
    let pages = 1;
    let truncated = false;
    let outcome = null; // set when the lookup stops before the last result page

    for (let page = 1; page <= pages; page++) {
      if (page > 1 && Date.now() - started > SOFT_DEADLINE_MS) {
        outcome = { reason: 'timeout', excerpt: `stopped after ${page - 1} of ${pages} result pages` };
        break;
      }
      let res;
      let body;
      try {
        res = await fetch(pageUrl(text, page), { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        body = await res.text();
      } catch (e) {
        outcome = { reason: isTimeout(e) ? 'timeout' : 'other', excerpt: String((e && e.message) || e) };
        break;
      }
      if (res.status === 403 || res.status === 429) {
        outcome = { reason: 'blocked', excerpt: `HTTP ${res.status}` };
        break;
      }
      if (!res.ok) {
        outcome = { reason: CHALLENGE.test(body) ? 'blocked' : 'http_error', excerpt: `HTTP ${res.status}` };
        break;
      }
      const parsed = parsePage(body);
      if (!parsed || (parsed.cards.length === 0 && parsed.total > 0)) {
        outcome = { reason: !parsed && CHALLENGE.test(body) ? 'blocked' : 'layout_changed', excerpt: clean(body).slice(0, 300) };
        break;
      }
      if (page === 1) {
        total = parsed.total;
        const needed = Math.max(1, Math.ceil(total / PER_PAGE));
        pages = Math.min(needed, MAX_PAGES);
        truncated = needed > MAX_PAGES;
      }
      for (const c of parsed.cards) {
        if (wordKey(searchText(c.name)) === target) matches.push(c);
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: matches.map((m) => `${m.name}, ${m.address}, ${m.reviews_count} Bewertungen`).join(' | ').slice(0, 300),
      };
    }
    if (outcome) return fail(outcome.reason, firstUrl, outcome.excerpt);
    if (truncated) return fail('other', firstUrl, `${total} results for "${text}"; only the first ${MAX_PAGES * PER_PAGE} were checked`);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `Unternehmen (${total}) for "${text}": no company named "${keyword}"`,
    };
  } catch (err) {
    return fail('other', firstUrl, String((err && err.message) || err));
  }
}
