export const meta = {
  task: 'MY-daganghalal.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'halal_verified', 'business_type', 'year_established', 'main_products', 'employees', 'main_markets', 'country', 'company_url'],
  canary: { found: 'VNI Scientific Sdn Bhd', not_found: 'Syarikat Tiada Wujud Sdn Bhd' },
};

const BASE = 'https://www.daganghalal.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 4;          // result pages read per lookup (about 24 products each)
const TIME_BUDGET_MS = 35000; // stop paging after this, so the whole call stays under 60 s
const MAX_DETAIL_PAGES = 3;   // company pages read per lookup

// Malaysian legal-form words, dropped before comparing names.
const LEGAL_FORMS = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'plt', 'llp']);

/** Normalised name for comparison: NFKC, lower case, no punctuation or spaces, no legal form. Keeps non-Latin letters. */
export function normalizeName(str) {
  const words = String(str || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  return words.filter((w) => !LEGAL_FORMS.has(w)).join('');
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function searchUrl(query, page) {
  const base = `${BASE}/search/----/----/?keyword=${encodeURIComponent(query)}`;
  return page > 1 ? `${base}&pageNum=${page}` : base;
}

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.text();
  return { res, body };
}

/** Returns a blocking reason, or '' when the page is a normal answer. */
function blockedReason(res, body) {
  if (res.status === 403 || res.status === 429) return `HTTP ${res.status}`;
  if (res.headers.get('cf-mitigated') === 'challenge') return 'bot check (cloudflare challenge)';
  if (/Just a moment\.\.\.|cf-chl-|Attention Required! \| Cloudflare/i.test(body.slice(0, 5000))) return 'bot check (cloudflare challenge page)';
  if (/\/Home\/Account\/Login/i.test(res.url)) return 'login wall';
  return '';
}

/** Company cards on a search page: name from the card heading, link to its company page. */
function parseCards(html) {
  const cards = [];
  const re = /<h3 class="supp-name">([\s\S]*?)<\/h3>[\s\S]{0,2000}?href="(\/Company\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) cards.push({ name: clean(m[1]), path: m[2] });
  const seen = new Set();
  return cards.filter((c) => (seen.has(c.path) ? false : seen.add(c.path)));
}

function parseTotalPages(html) {
  const m = html.match(/<div>\s*Of\s+(\d+)\s*<\/div>/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/** Profile table on a company page: label/value pairs (two per row). */
function parseProfile(html) {
  const profile = {};
  const re = /<li class="com-td[13]"><span class="bold-txt">([\s\S]*?)<\/span><\/li>\s*<li class="com-td[24]"><span>([\s\S]*?)<\/span><\/li>/g;
  let m;
  while ((m = re.exec(html))) profile[clean(m[1])] = clean(m[2]);
  return profile;
}

async function companyRecord(card) {
  const url = BASE + card.path;
  try {
    const { res, body } = await get(url);
    const h1 = body.match(/<h1>([\s\S]*?)<\/h1>/i);
    if (!res.ok || !h1) {
      // The search card already proves the match; keep the record minimal and say why.
      return { record: { name: card.name, halal_verified: null, business_type: '', year_established: '', main_products: '', employees: '', main_markets: '', country: '', company_url: url }, note: `company page ${res.ok ? 'layout not as expected' : 'HTTP ' + res.status}` };
    }
    const p = parseProfile(body);
    const country = body.match(/Country:<\/div>\s*<div class="contact-row-r">([\s\S]*?)<\/div>/i);
    return {
      record: {
        name: clean(h1[1]),
        halal_verified: /alt="Halal Verified"/i.test(body),
        business_type: p['Business Type'] || '',
        year_established: p['Year Established'] || '',
        main_products: p['Main Products'] || '',
        employees: p['No. of Employees'] || '',
        main_markets: p['Main Markets'] || '',
        country: country ? clean(country[1]) : '',
        company_url: url,
      },
      note: '',
    };
  } catch (e) {
    return { record: { name: card.name, halal_verified: null, business_type: '', year_established: '', main_products: '', employees: '', main_markets: '', country: '', company_url: url }, note: 'company page ' + (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : 'failed') };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const query = String(keyword || '').trim().replace(/\s+/g, ' ');
  const target = normalizeName(query);
  if (!target) return out('couldnt_check', 'other', [], searchUrl(query, 1), 'the name has no words left after removing the legal form');

  const firstUrl = searchUrl(query, 1);
  try {
    const matches = [];
    const seen = new Set();
    let page = 1;
    let totalPages = 1;
    let lastUrl = firstUrl;

    while (true) {
      const url = searchUrl(query, page);
      lastUrl = url;
      const { res, body } = await get(url);

      const block = blockedReason(res, body);
      if (block) return out('couldnt_check', 'blocked', [], url, block);
      if (!res.ok) return out('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`);

      if (/\/Home\/SearchNotFound/i.test(res.url) || /Search Not Found With Keyword/i.test(body)) {
        if (page === 1) return out('not_found', '', [], firstUrl, `The site reports no results for "${query}".`);
        break;
      }

      const cards = parseCards(body);
      if (page === 1) {
        if (cards.length === 0 && !/products found/i.test(body)) {
          return out('couldnt_check', 'layout_changed', [], url, clean(body).slice(0, 300));
        }
        totalPages = parseTotalPages(body);
      }

      for (const c of cards) {
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        if (normalizeName(c.name) === target) matches.push(c);
      }
      if (matches.length) break;
      if (page >= totalPages) break;
      if (page >= MAX_PAGES || Date.now() - started > TIME_BUDGET_MS) {
        return out('couldnt_check', 'timeout', [], lastUrl,
          `no match on the first ${page} of ${totalPages} result pages; the rest were not read, so this is not a proof of absence`);
      }
      page++;
    }

    if (matches.length === 0) {
      return out('not_found', '', [], firstUrl,
        `No listed company named "${query}" among ${seen.size} company cards on ${page} of ${totalPages} result page(s).`);
    }

    const records = [];
    const notes = [];
    for (const card of matches.slice(0, MAX_DETAIL_PAGES)) {
      const { record, note } = await companyRecord(card);
      records.push(record);
      if (note) notes.push(note);
    }
    const first = records[0];
    const excerpt = [
      `Halal Verified: ${first.halal_verified === null ? 'unknown' : first.halal_verified ? 'yes' : 'no'}`,
      first.business_type && `Business Type: ${first.business_type}`,
      first.year_established && `Year Established: ${first.year_established}`,
      first.country && `Country: ${first.country}`,
      notes.length ? notes.join('; ') : '',
    ].filter(Boolean).join('. ');
    return out('found', '', records, first.company_url, excerpt);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return out('couldnt_check', timedOut ? 'timeout' : 'other', [], lastSafeUrl(query), String(err?.message || err));
  }
}

function lastSafeUrl(query) {
  return searchUrl(query, 1);
}
