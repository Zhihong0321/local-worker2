export const meta = {
  task: 'CH-jobs.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'location', 'industry', 'open_jobs', 'profile_url'],
  canary: { found: 'Acino Pharma AG', not_found: 'Schweizerische Phantasie Treuhand GmbH' },
};

const BASE = 'https://www.jobs.ch';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-CH,de;q=0.9,en;q=0.7',
};
// Every company search page carries this heading; without it the page is not the one we expect.
const SEARCH_PAGE_MARKER = 'Finde deine passende Firma in der Schweiz';
const MAX_PAGES = 3;
const DEADLINE_MS = 50000; // the whole call must finish well under 60 s

// Trailing legal forms are dropped before comparing, so "ACME AG" matches "Acme".
const LEGAL_FORMS = new Set(['ag', 'sa', 'sarl', 'sagl', 'gmbh', 'ltd', 'llc', 'inc', 'co', 'kg', 'ohg', 'sas', 'bv', 'ab',
  'plc', 'corp', 'limited', 'se', 'slu', 'srl', 'aktiengesellschaft', 'anonyme', 'cie']);

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower case, no accents, no punctuation: "Nestlé S.A." -> "nestle sa". */
function fold(str) {
  return String(str || '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase().replace(/ß/g, 'ss').replace(/&/g, ' und ')
    .replace(/\b(\w)\.(?=\w\.)/g, '$1') // "s.a." -> "sa."
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The comparison key: folded, trailing legal form removed, spaces removed. */
function coreName(str) {
  const tokens = fold(str).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

/** One company card per `data-cy="card-<id>"` block on a company search page. */
function parseCards(html, pageUrl) {
  const starts = [];
  const re = /data-cy="card-([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) starts.push({ id: m[1], at: m.index });
  const cards = [];
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : html.length;
    const seg = html.slice(s.at, Math.min(end, s.at + 8000));
    const h2 = seg.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) return;
    const name = clean(h2[1]);
    if (!name) return;
    const href = seg.match(/href="(\/de\/firmen\/[^"]+)"/);
    const loc = seg.match(/data-cy="company-card-location"[^>]*>([\s\S]*?)<\/p>/);
    const ind = seg.match(/data-cy="company-card-industry"[^>]*>([\s\S]*?)<\/p>/);
    const jobs = seg.match(/>\s*(\d+)\s+Jobs?\s*</);
    cards.push({
      id: s.id,
      name,
      profile_url: href ? BASE + decode(href[1]) : '',
      location: loc ? clean(loc[1]) : '',
      industry: ind ? clean(ind[1]) : '',
      open_jobs: jobs ? Number(jobs[1]) : null,
      page_url: pageUrl,
    });
  });
  return cards;
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const term = String(keyword || '').trim();
  const firstUrl = `${BASE}/de/firmen/?term=${encodeURIComponent(term)}`;
  try {
    const target = coreName(term);
    if (!target) return couldnt('other', firstUrl, 'the company name has no letters or digits to compare');

    const seen = new Map(); // card id -> card
    let total = null;      // "N Firmen mit Stichwort ..." on page 1
    let incomplete = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? firstUrl : `${BASE}/de/firmen/?page=${page}&term=${encodeURIComponent(term)}`;
      const left = DEADLINE_MS - (Date.now() - started);
      if (left < 3000) { incomplete = true; break; }

      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(Math.min(25000, left)) });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (!html.includes(SEARCH_PAGE_MARKER)) {
        if (/awswaf|captcha|challenge-platform|cf-chl/i.test(html)) return couldnt('blocked', url, 'bot check or captcha page');
        return couldnt('layout_changed', url, html.slice(0, 200));
      }

      if (page === 1) {
        const hdr = html.match(/(\d+)\s+Firmen?\s+mit\s+Stichwort/);
        total = hdr ? Number(hdr[1]) : null;
      }

      let added = 0;
      for (const c of parseCards(html, url)) {
        if (!seen.has(c.id)) { seen.set(c.id, c); added++; }
      }
      if (added === 0 || (total !== null && seen.size >= total)) break;
    }

    const cards = [...seen.values()];
    const matches = cards.filter((c) => coreName(c.name) === target);

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((c) => ({
          name: c.name,
          company_id: c.id,
          location: c.location,
          industry: c.industry,
          open_jobs: c.open_jobs,
          profile_url: c.profile_url,
        })),
        source_url: matches[0].page_url,
        excerpt: matches.map((c) => [c.name, c.location, c.industry, c.open_jobs !== null ? `${c.open_jobs} jobs` : '']
          .filter(Boolean).join(' · ')).join(' | ').slice(0, 500),
      };
    }

    // No exact match. Only call it not_found when every hit the site listed was read.
    if (total !== null && seen.size < total) {
      return couldnt(incomplete ? 'timeout' : 'layout_changed', firstUrl,
        `site lists ${total} companies, only ${seen.size} could be read`);
    }
    if (total === null && cards.length === 0) {
      return couldnt('layout_changed', firstUrl, 'search page has no company count and no company cards');
    }
    const names = cards.map((c) => c.name);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: names.length
        ? `Site search for "${term}" returned only other names: ${names.slice(0, 5).join('; ')}`
        : `Site search for "${term}" returned no companies`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, firstUrl, err && err.message ? err.message : err);
  }
}
