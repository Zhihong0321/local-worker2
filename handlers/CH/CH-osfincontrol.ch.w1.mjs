export const meta = {
  task: 'CH-osfincontrol.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'street', 'place'],
  canary: { found: '1.618 Capital AG', not_found: 'Nicht Existierende Vermögensverwaltung AG' },
};

// The site's own search (the "Finanzinstitute" table, shown in an iframe on the home page).
// It is a substring search on the institution name, 10 entries per page, and an empty page means the end.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;            // at most 50 entries are read for one name
const TIME_BUDGET_MS = 40000;   // do not start another page after this (the whole call must end under 60 s)
const BLOCK_RE = /captcha|cf-chl|just a moment|access denied|incapsula/i;

// Legal forms that are dropped from the END of the typed name before searching (a wider search, then exact match).
const LEGAL_TAIL = new Set(['ag', 'sa', 'sagl', 'gmbh', 'sarl', 'ltd', 'limited', 'llc', 'kg', 'plc', 'inc', 'aktiengesellschaft']);

const NAMED = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', laquo: '«', raquo: '»',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Normalised name for comparison: case, accents, punctuation and spacing removed; common legal forms unified.
function nameKey(s) {
  let t = decodeEntities(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/\baktiengesellschaft\b/g, 'ag')
    .replace(/\blimited\b/g, 'ltd')
    .replace(/\bsociete anonyme\b/g, 'sa')
    .replace(/\bgesellschaft mit beschrankter haftung\b/g, 'gmbh');
  return t.replace(/ /g, '');
}

function searchCore(keyword) {
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_TAIL.has(words[words.length - 1].replace(/\./g, '').toLowerCase())) words.pop();
  return words.join(' ');
}

function pageUrl(core, page) {
  return `https://www.osfincontrol.ch/TableIFrame?open=UVV&search=${encodeURIComponent(core)}&page=${page}&toggled=true`;
}

// Returns null when the table body is missing (layout changed), otherwise the rows of this page.
function parseRows(html) {
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return null;
  const rows = [];
  for (const m of tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cleanText(c[1]));
    if (cells.length >= 3 && cells[0]) rows.push({ name: cells[0], street: cells[1], place: cells[2] });
  }
  return rows;
}

const couldnt = (reason, source_url, excerpt) =>
  ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const input = String(keyword ?? '').trim();
    const wanted = nameKey(input);
    if (!wanted) return couldnt('other', '', 'empty company name');

    const core = searchCore(input);
    const firstUrl = pageUrl(core, 1);
    let ended = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > TIME_BUDGET_MS) break;
      const url = pageUrl(core, page);

      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'de-CH,de;q=0.9,en;q=0.7',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      const rows = parseRows(html);
      if (rows === null || !html.includes('Finanzinstitut')) {
        if (BLOCK_RE.test(html)) return couldnt('blocked', url, 'bot check page');
        return couldnt('layout_changed', url, html.slice(0, 300));
      }

      if (rows.length === 0) {
        if (page === 1) {
          if (/Keine Passenden/i.test(html)) {
            return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: 'Keine Passenden Einträge gefunden' };
          }
          return couldnt('layout_changed', url, 'no rows and no "no matching entries" text');
        }
        ended = true;
        break;
      }

      const hits = rows.filter((r) => nameKey(r.name) === wanted);
      if (hits.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: hits.map((h) => ({ name: h.name, street: h.street, place: h.place })),
          source_url: url,
          excerpt: `OSFINcontrol list of supervised financial institutions: ${hits[0].name}, ${hits[0].street}, ${hits[0].place}`.slice(0, 500),
        };
      }
    }

    if (!ended) {
      return couldnt('other', firstUrl, `search "${core}" has more than ${MAX_PAGES} pages of results; the name was not in the first ${MAX_PAGES} pages`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `Search "${core}": entries listed, none with this name`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', pageUrl(searchCore(String(keyword ?? '').trim()), 1), String(err?.message || err));
  }
}
