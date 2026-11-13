export const meta = {
  task: 'FR-118000.fr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'com_code', 'category', 'street', 'postal_code', 'city', 'phone', 'detail_url'],
  canary: { found: 'Marionnaud Nantes Carrefour', not_found: 'Zqxwvkj Entreprise Inexistante' },
};

const SEARCH = 'https://www.118000.fr/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 25000;
// A further result page is fetched only while the whole call has used less time than this (the call must end under 60 s).
const NO_NEW_PAGE_AFTER_MS = 30000;
const LEGAL_FORMS = new Set(['sa', 'sas', 'sasu', 'sarl', 'sarlu', 'eurl', 'sci', 'snc', 'scs', 'sca', 'selarl', 'sel', 'earl',
  'gie', 'scop', 'scic', 'societe', 'anonyme', 'simplifiee', 'unipersonnelle', 'responsabilite', 'limitee']);
const NO_RESULTS_RE = /no-results-section|Aucun r.sultat/;
const BOT_RE = /captcha|just a moment|access denied|cf-chl|verify you are human/i;

/** Lower case, accents and punctuation removed, words separated by one space. Dots go first so "S.A.R.L." reads as "sarl". */
function fold(str) {
  return String(str || '').replace(/\./g, '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The name without legal-form words, so "ACME SARL" and "Acme" compare equal. */
function nameKey(str) {
  return fold(str).split(' ').filter((w) => w && !LEGAL_FORMS.has(w)).join(' ');
}

/** The search text: the name without legal-form words (the site matches listing names, not legal forms). */
function queryFor(keyword) {
  const words = String(keyword || '').trim().split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(fold(w)));
  return words.length ? words.join(' ') : String(keyword || '').trim();
}

function safeChar(cp, fallback) {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function searchUrl(query, page) {
  const u = new URL(SEARCH);
  u.searchParams.set('who', query);
  u.searchParams.set('where', '');
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

/** "11 809 résultats" -> 11809; "1 résultat" -> 1. Null when the count line is not there. */
function parseTotal(html) {
  const m = html.match(/class="results-count"[\s\S]*?<strong>([^<]*)<\/strong>/i);
  if (!m || !/sultat/i.test(m[1])) return null;
  const digits = m[1].replace(/\D/g, '');
  return digits ? Number(digits) : null;
}

/** One record per result card on a search page. */
function parseCards(html) {
  return html.split('<article class="result-card').slice(1).map((block) => {
    const title = block.match(/<h2 class="card-title"[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) return null;
    const addr = block.match(/<address[\s\S]*?<\/address>/i)?.[0] || '';
    const part = (prop) => cleanText((addr.match(new RegExp(`itemprop="${prop}">([\\s\\S]*?)<\\/span>`, 'i')) || [])[1]);
    const detailUrl = new URL(decodeEntities(title[1]), SEARCH).href;
    return {
      name: cleanText(title[2]),
      com_code: (detailUrl.match(/\/e_([A-Za-z0-9]+)/) || [])[1] || '',
      category: cleanText((block.match(/<p class="card-category">([\s\S]*?)<\/p>/i) || [])[1]),
      street: part('streetAddress'),
      postal_code: part('postalCode'),
      city: part('addressLocality'),
      phone: cleanText((block.match(/class="phone-number"[^>]*>([\s\S]*?)<\/a>/i) || [])[1]),
      detail_url: detailUrl,
    };
  }).filter(Boolean);
}

function summary(r) {
  return `${r.name} | ${r.street}, ${r.postal_code} ${r.city} | ${r.phone}`;
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let url = searchUrl(queryFor(keyword), 1);
  try {
    const want = nameKey(keyword);
    if (!want) return out('couldnt_check', 'other', [], url, 'the name has no words besides the legal form');

    let total = 0, pages = 1, page = 1, scanned = 0, matchUrl = '';
    const matches = [];
    for (;;) {
      if (page > 1 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) break;
      url = searchUrl(queryFor(keyword), page);
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const html = await res.text();

      if (res.status === 403 || res.status === 429 || (html.length < 20000 && BOT_RE.test(html))) {
        return out('couldnt_check', 'blocked', [], url, `HTTP ${res.status} on result page ${page}`);
      }
      // The site answers a search with no hits with its own "no results" page (HTTP 404 with that page body).
      if (NO_RESULTS_RE.test(html) && (res.ok || res.status === 404)) {
        if (page === 1) return out('not_found', '', [], url, `site search: no results (HTTP ${res.status})`);
        break;
      }
      if (!res.ok) {
        return out('couldnt_check', 'http_error', [], url, `HTTP ${res.status} on result page ${page}`);
      }
      const t = parseTotal(html);
      if (t === null) {
        return out('couldnt_check', 'layout_changed', [], url, html.slice(0, 300));
      }
      const blocks = html.split('<article class="result-card').length - 1;
      if (page === 1) {
        if (blocks === 0) return out('couldnt_check', 'layout_changed', [], url, html.slice(0, 300));
        total = t;
        pages = Math.max(1, Math.ceil(t / blocks));
      }
      scanned = page;
      for (const card of parseCards(html)) {
        if (nameKey(card.name) === want) {
          if (!matchUrl) matchUrl = url;
          matches.push(card);
        }
      }
      if (page >= pages) break;
      page++;
    }

    const exhausted = scanned >= pages;
    const unique = [...new Map(matches.map((r) => [r.detail_url, r])).values()];
    if (unique.length) {
      const first = unique[0];
      return out('found', '', unique, matchUrl, `${summary(first)} | ${scanned} of ${pages} result page(s) read, ${total} results`);
    }
    if (exhausted) {
      return out('not_found', '', [], url, `${total} results, all ${pages} page(s) read: no listing with this name`);
    }
    return out('couldnt_check', 'other', [], url,
      `no exact name match in ${scanned} of ${pages} result pages (${total} results); not conclusive`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], url, String(err?.message || err));
  }
}
