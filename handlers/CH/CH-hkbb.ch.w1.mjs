export const meta = {
  task: 'CH-hkbb.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'city', 'website', 'branches'],
  canary: { found: 'F. Hoffmann-La Roche AG', not_found: 'Zzyxqwerk Nichtexistent GmbH' },
};

// Handelskammer beider Basel, Mitgliederverzeichnis: GET with a name filter, 10 entries per page.
// The site matches the filter as a case-insensitive substring of the company name, so the handler
// searches with one distinctive word of the name, reads every page and compares normalised names.
const BASE = 'https://www.hkbb.ch/de/angebot-und-netzwerk/mitgliederverzeichnis/index.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 8;        // per search word: 80 entries at most
const START_LIMIT_MS = 30000; // no new request after this, so the whole call ends under 60 s
const NO_RESULT = 'Leider wurden keine Resultate gefunden';

const LEGAL = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'kg', 'se', 'co', 'ug', 'plc', 'ab', 'bv', 'llp', 'sas', 'srl', 'spa']);
const STOP = new Set(['und', 'and', 'the', 'der', 'die', 'das', 'fur', 'von', 'des', 'of']);

/** Words of a string: letters and digits, case and umlauts kept. */
function words(s) {
  return String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Normalised key: accents, case, punctuation and a trailing legal form removed. */
function key(s) {
  let t = words(s).map((w) => w.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase());
  let changed = true;
  while (changed && t.length > 1) {
    changed = false;
    for (const k of [4, 2, 1]) {
      if (t.length > k && LEGAL.has(t.slice(-k).join(''))) {
        t = t.slice(0, -k);
        changed = true;
        break;
      }
    }
  }
  return t.join('');
}

/** Keys the listed name may have: the whole input, and the input without a trailing ", City". */
function wantedKeys(name) {
  const keys = [key(name)];
  const comma = name.lastIndexOf(',');
  if (comma > 0) keys.push(key(name.slice(0, comma)));
  return keys.filter(Boolean);
}

/** Search words from the name: longest first, at most four, no legal forms. */
function searchTerms(name) {
  const seen = new Set();
  return words(name)
    .filter((w) => w.length >= 3 && !LEGAL.has(w.toLowerCase()) && !STOP.has(w.toLowerCase()))
    .sort((a, b) => b.length - a.length)
    .filter((w) => {
      const k = w.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4);
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function searchUrl(term, pageno) {
  const url = new URL(BASE);
  url.searchParams.set('form[name]', term);
  url.searchParams.set('form[branche]', '');
  url.searchParams.set('form[ort]', '');
  if (pageno > 1) url.searchParams.set('pageno', String(pageno));
  return url.href;
}

/** Entries of one result page: { name, city, website, branches, raw }. */
function parseItems(html) {
  const blocks = html.split('<div class="mitgliederverzeichnis-result-item">').slice(1);
  return blocks.map((block) => {
    const titleRaw = (block.match(/<span class="mitgliederverzeichnis-result-item-title">([\s\S]*?)<\/span>/) || [])[1] || '';
    const title = decode(titleRaw);
    const cut = title.lastIndexOf(', ');
    const name = cut > 0 ? title.slice(0, cut) : title;
    const city = cut > 0 ? title.slice(cut + 2) : '';
    const site = (block.match(/<a\s[^>]*href="([^"]*)"[^>]*mitgliederverzeichnis-result-item-url/) || [])[1] || '';
    const branches = [...block.matchAll(/<span class="mitgliederverzeichnis-result-item-branche">([\s\S]*?)<\/span>/g)]
      .map((m) => decode(m[1]))
      .filter(Boolean);
    return { name, city, website: decode(site), branches, raw: title };
  }).filter((e) => e.name);
}

function result(status, reason, source, excerpt, records = []) {
  return { status, reason, records, source_url: source, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Read all result pages for one search word. outcome: match | complete | capped | blocked | layout | http | timeout */
async function scanTerm(term, wanted, startedAt) {
  // wanted: array of normalised keys
  const matches = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() - startedAt > START_LIMIT_MS) return { outcome: 'timeout', matches, seen, source: searchUrl(term, 1) };
    const url = searchUrl(term, page);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'de-CH,de;q=0.9,en;q=0.5',
      },
    });
    if (res.status === 403 || res.status === 429) return { outcome: 'blocked', matches, seen, source: url, http: res.status };
    if (!res.ok) return { outcome: 'http', matches, seen, source: url, http: res.status };

    const html = await res.text();
    if (!html.includes('class="mitgliederverzeichnis-result"')) {
      if (/captcha|cf-chl|challenge-platform|Access denied/i.test(html)) return { outcome: 'blocked', matches, seen, source: url, http: res.status };
      return { outcome: 'layout', matches, seen, source: url, html: html.slice(0, 300) };
    }

    const items = parseItems(html);
    if (items.length === 0) {
      if (html.includes(NO_RESULT)) return { outcome: 'complete', matches, seen, source: url };
      return { outcome: 'layout', matches, seen, source: url, html: html.slice(0, 300) };
    }

    seen += items.length;
    for (const it of items) {
      if (wanted.includes(key(it.name))) matches.push(it);
    }
    if (!html.includes('class="pagination-next"')) return { outcome: 'complete', matches, seen, source: url };
  }
  return { outcome: 'capped', matches, seen, source: searchUrl(term, 1) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startedAt = Date.now();
  try {
    const name = String(keyword || '').trim();
    const wanted = wantedKeys(name);
    const terms = searchTerms(name);
    if (wanted.length === 0 || terms.length === 0) {
      return result('couldnt_check', 'other', BASE, 'no word in the name to search the directory with');
    }

    for (const term of terms) {
      const r = await scanTerm(term, wanted, startedAt);
      if (r.outcome === 'blocked') return result('couldnt_check', 'blocked', r.source, `HTTP ${r.http || ''} blocked or challenge page`);
      if (r.outcome === 'http') return result('couldnt_check', 'http_error', r.source, `HTTP ${r.http}`);
      if (r.outcome === 'layout') return result('couldnt_check', 'layout_changed', r.source, r.html || 'result list not found on the page');
      if (r.outcome === 'timeout') return result('couldnt_check', 'timeout', r.source, 'time limit reached before all pages were read');
      if (r.matches.length > 0) {
        return result('found', '', searchUrl(term, 1),
          r.matches.map((m) => m.raw).join(' | '),
          r.matches.map((m) => ({ name: m.name, city: m.city, website: m.website, branches: m.branches })));
      }
      if (r.outcome === 'complete') {
        // Every entry containing this word was read and none has the same normalised name.
        return result('not_found', '', r.source,
          r.seen > 0 ? `${r.seen} entries for "${term}" checked, none with this name` : NO_RESULT);
      }
      // capped: too many entries for this word, try the next word
    }
    return result('couldnt_check', 'other', searchUrl(terms[0], 1),
      `more than ${MAX_PAGES * 10} entries for each of the search words ${terms.join(', ')}, list not fully read`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return result('couldnt_check', timeout ? 'timeout' : 'other', BASE, String(err?.message || err));
  }
}
