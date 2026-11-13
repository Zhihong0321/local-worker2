export const meta = {
  task: 'AR-boletinoficial.gba.gob.ar',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'bulletin_date', 'section', 'page', 'excerpt', 'pdf_url'],
  canary: { found: 'Caja de Valores Sociedad Anónima', not_found: 'Inmobiliaria Zqxvwkt Ñandubay S.A.' },
};

// The site has a full-text search over the bulletin pages (GET /buscar). Each hit is a bulletin page whose text
// contains the search words, with a short excerpt. A hit is a published mention of the name, not a company register.
const BASE = 'https://boletinoficial.gba.gob.ar';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;            // result pages checked (5 hits per page)
const START_LIMIT_MS = 30000;   // do not start another page after 30 s, so the whole call stays under 60 s
// Legal-form words at the end of a name: left out of the search words, the full name is still checked below.
const LEGAL_TAIL = new Set(['sa', 'sas', 'srl', 'ltda', 's', 'a', 'l', 'r', 'sociedad', 'anonima', 'limitada',
  'responsabilidad', 'simplificada']);

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function cleanText(html) {
  return String(html || '')
    .replace(/<\/?span[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&hellip;/gi, '...').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Comparable form of a name: no case, no accents, no punctuation, legal forms unified (S.A. = Sociedad Anónima). */
function nameTokens(text) {
  let s = stripAccents(String(text || '')).toLowerCase();
  s = s.replace(/([a-z])-\s+([a-z])/g, '$1$2');          // OCR line-break hyphen: "nomi- nal"
  s = ' ' + s.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  s = s.replace(/ sociedad anonima simplificada /g, ' sas ')
    .replace(/ sociedad de responsabilidad limitada /g, ' srl ')
    .replace(/ s a s /g, ' sas ')
    .replace(/ s r l /g, ' srl ')
    .replace(/ s a /g, ' sa ')
    .replace(/ sociedad anonima /g, ' sa ');
  return s.trim().split(' ').filter(Boolean);
}

/** True when the words of `needle` appear next to each other, in order, inside `hay`. */
function containsRun(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** The words sent to the site: the name without its trailing legal form. */
function searchWords(keyword) {
  const words = String(keyword || '').replace(/[.,;:()"'“”]/g, ' ').split(/\s+/).filter(Boolean);
  let end = words.length;
  while (end > 1 && LEGAL_TAIL.has(stripAccents(words[end - 1]).toLowerCase().replace(/[^a-z]/g, ''))) end--;
  return words.slice(0, end).join(' ');
}

/** Hits on one results page: one entry per excerpt, with its section, date, page and PDF link. */
function parseHits(html) {
  const hits = [];
  for (const block of html.split('<div class="result-box">').slice(1)) {
    const section = cleanText((block.match(/<div class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    const date = cleanText((block.match(/fecha de publicación:\s*<strong>([^<]*)<\/strong>/) || [])[1]);
    const re = /<a class="page"[^>]*href="([^"]*)"[^>]*>\s*Página\s*(\d+)\s*<\/a>\s*<p class="excerpt">([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(block))) {
      hits.push({ section, date, pdfPath: m[1], page: m[2], excerpt: cleanText(m[3]) });
    }
  }
  return hits;
}

function lastPageNumber(html) {
  let max = 1;
  for (const m of html.matchAll(/buscar\?page=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

const blockedWords = /captcha|cf-chl|recaptcha|access denied/i;

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const words = searchWords(name);
  const wanted = nameTokens(name);
  const urlFor = (page) => `${BASE}/buscar?search%5Bwords%5D=${encodeURIComponent(words)}${page > 1 ? `&page=${page}` : ''}`;
  const firstUrl = urlFor(1);

  if (!wanted.length) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
  }

  try {
    const records = [];
    const seen = new Set();
    let total = 1;
    let fetched = 0;
    let matchUrl = '';
    let seenResults = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) {
        if (page > total) break;
        if (Date.now() - started > START_LIMIT_MS) break;
      }
      const url = urlFor(page);

      let res;
      try {
        res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-AR,es;q=0.9',
          },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url,
          excerpt: String(err && err.message ? err.message : err).slice(0, 200) };
      }

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();
      const hasResults = html.includes('class="result-box"');
      const noResults = html.includes('No se han encontrado');
      if (!hasResults && !noResults) {
        if (blockedWords.test(html)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: cleanText(html).slice(0, 200) };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 200) };
      }

      fetched++;
      if (hasResults) seenResults = true;
      if (page === 1) total = lastPageNumber(html);
      if (!hasResults) break;   // "No se han encontrado boletines..." : the search answered, nothing matches

      for (const hit of parseHits(html)) {
        if (!containsRun(nameTokens(hit.excerpt), wanted)) continue;
        const key = `${hit.pdfPath}|${hit.page}|${hit.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!matchUrl) matchUrl = url;
        records.push({
          name,
          bulletin_date: hit.date,
          section: hit.section,
          page: hit.page,
          excerpt: hit.excerpt.slice(0, 400),
          pdf_url: new URL(hit.pdfPath, BASE).href,
        });
      }
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: matchUrl, excerpt: records[0].excerpt };
    }
    if (total <= fetched) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: fetched === 1 && !seenResults
          ? `Search "${words}" returned no bulletins ("No se han encontrado boletines").`
          : `Search "${words}": ${fetched} result page(s) checked; no excerpt contains "${name}".` };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
      excerpt: `Search "${words}" has ${total} result pages; the first ${fetched} do not show "${name}". Absence not proven.` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
      excerpt: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}
