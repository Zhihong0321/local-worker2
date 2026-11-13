export const meta = {
  task: 'DE-emas-register.de',
  want: 'w1',
  tier: 2,
  method: 'other',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'registered_at', 'city', 'postcode', 'street', 'state', 'employees', 'sites'],
  canary: { found: 'Stadtwerke Wertheim GmbH', not_found: 'Phantasie Verwaltungs GmbH' },
};

const BASE = 'https://www.emas-register.de';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'kg', 'kgaa', 'ohg', 'ug', 'se', 'gbr', 'co', 'ev', 'eg']);

/** Lower-case word tokens; umlauts folded, punctuation (incl. "&") dropped. */
function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/** Name for comparison: tokens with trailing legal-form words removed. */
function normName(s) {
  const t = tokens(s);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** The search term: the typed name without its trailing legal form (the site search is a substring search). */
function searchCore(keyword) {
  const words = String(keyword || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const t = tokens(words[words.length - 1]);
    if (t.length === 0 || (t.length === 1 && LEGAL.has(t[0]))) words.pop(); else break;
  }
  return words.join(' ');
}

/** Longest plain-ASCII word of the core. The site's search misses umlauts ("Lubeck" ≠ "Lübeck"), so this word is a second search term. */
function asciiWord(core) {
  const words = core.split(/\s+/).filter((w) => /^[\x21-\x7e]+$/.test(w) && tokens(w).length > 0);
  words.sort((a, b) => b.length - a.length);
  return words[0] || '';
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Text of the first <name>…</name> inside xml, or ''. */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : '';
}

/** Full record: a search that returns exactly one hit answers with <emasRegistereintrag>. */
function fromFullRecord(block) {
  const org = (block.match(/<Organisation>([\s\S]*?)<\/Organisation>/) || [, ''])[1];
  const addr = (org.match(/<Anschrift>([\s\S]*?)<\/Anschrift>/) || [, ''])[1];
  const name = tag(org, 'Name');
  return {
    name,
    regnr: tag(org, 'Registernummer'),
    record: {
      name,
      registration_number: tag(org, 'Registernummer'),
      registered_at: tag(org, 'Registrierung').replace(/Z$/, ''),
      city: tag(addr, 'Ort'),
      postcode: tag(addr, 'Postleitzahl'),
      street: [tag(addr, 'Strasse'), tag(addr, 'Hausnummer')].filter(Boolean).join(' '),
      state: tag(addr, 'Bundesland'),
      employees: tag(org, 'Mitarbeiter'),
      sites: String((block.match(/<Standort>/g) || []).length),
    },
  };
}

/** Preview row: a search with several hits answers with one <vorschauListe> per hit. */
function fromPreview(block) {
  const name = tag(block, 'firma');
  const regnr = tag(block, 'registernummer');
  return {
    name,
    regnr,
    record: {
      name,
      registration_number: regnr,
      registered_at: '',
      city: tag(block, 'ort'),
      postcode: tag(block, 'postleitzahl'),
      street: '',
      state: '',
      employees: '',
      sites: tag(block, 'anzahlStandorte'),
    },
  };
}

function parseEntries(xml) {
  const out = [];
  for (const m of xml.matchAll(/<emasRegistereintrag>([\s\S]*?)<\/emasRegistereintrag>/g)) out.push(fromFullRecord(m[1]));
  for (const m of xml.matchAll(/<vorschauListe>([\s\S]*?)<\/vorschauListe>/g)) out.push(fromPreview(m[1]));
  return out;
}

const plain = (xml) => xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

/** One search request. Returns { count, entries } or { fail, excerpt }. */
async function searchOnce(term) {
  const url = `${BASE}/suchservice/search?firma=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    method: 'POST',
    // Connection: close lets the process exit cleanly on Node 24/Windows (no kept-alive socket).
    headers: { 'User-Agent': UA, 'Accept': 'text/xml, application/xml;q=0.9, */*;q=0.5', 'Connection': 'close' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };

  const xml = await res.text();
  // Let the closing socket finish before the caller returns: on Node 24/Windows, process.exit() during teardown aborts with code 127.
  await new Promise((r) => setTimeout(r, 300));
  const countMatch = xml.match(/<anzahlTreffer>\s*(\d+)\s*<\/anzahlTreffer>/);
  if (!/<(?:\w+:)?Suchergebnis[\s>]/.test(xml) || !countMatch) return { fail: 'layout_changed', excerpt: plain(xml) };
  const count = Number(countMatch[1]);
  const entries = parseEntries(xml);
  // Every hit the site counted must be readable, or a missing match could hide behind the gap.
  if (entries.length !== count) return { fail: 'layout_changed', excerpt: `${count} hits, ${entries.length} readable` };
  return { count, entries };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const core = searchCore(name);
  if (!core) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: `${BASE}/recherche`, excerpt: 'empty company name' };
  }
  const pageUrl = (term) => `${BASE}/recherche?firma=${encodeURIComponent(term)}&a=suche`;
  try {
    const want = normName(name);
    const terms = [core];
    const alt = asciiWord(core);
    if (alt.length >= 4 && alt !== core) terms.push(alt);

    const summary = [];
    const names = [];
    for (const term of terms) {
      const r = await searchOnce(term);
      if (r.fail) {
        return { status: 'couldnt_check', reason: r.fail, records: [], source_url: pageUrl(term), excerpt: r.excerpt };
      }
      const hits = r.entries.filter((e) => normName(e.name) === want);
      if (hits.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: hits.map((h) => h.record),
          source_url: pageUrl(term),
          excerpt: hits.map((h) => `${h.regnr}: ${h.name}`).join('; ').slice(0, 500),
        };
      }
      summary.push(`"${term}" ${r.count} hit(s)`);
      names.push(...r.entries.map((e) => e.name));
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl(core),
      excerpt: `No exact match for "${name}". Searched ${summary.join(', ')}. Similar names: ${[...new Set(names)].slice(0, 8).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: pageUrl(core),
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
