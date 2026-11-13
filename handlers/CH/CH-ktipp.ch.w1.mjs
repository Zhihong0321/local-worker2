export const meta = {
  task: 'CH-ktipp.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'list_url', 'description'],
  canary: { found: 'Euro Invest Inkasso GmbH', not_found: 'Bäckerei Sonnenschein Zürich GmbH' },
};

const INDEX_URL = 'https://www.ktipp.ch/service/warnlisten';
const SEARCH_ACTION = 'https://www.ktipp.ch/service/warnlisten/detail?tx_updkonsuminfo_konsuminfofewarnlistdetail%5Baction%5D=warnlistDetailFE&tx_updkonsuminfo_konsuminfofewarnlistdetail%5Bcontroller%5D=Warnlisten&type=1004&cHash=10d8ed17058d1904281f51db6f9bacd2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The nine public warning lists linked from /service/warnlisten, with the list id the site's own filter form uses.
const LISTS = [
  { id: 7, slug: 'unerwuenschte-oder-laestige-telefonanrufe' },
  { id: 8, slug: 'aktuelle-faelle-von-phishing' },
  { id: 9, slug: 'registerhaie-und-adressbuchschwindler' },
  { id: 11, slug: 'internetshops' },
  { id: 14, slug: 'finanzberater-und-geldanlage-firmen' },
  { id: 15, slug: 'dubiose-geschaeftsvorschlaege-nigeria-connection' },
  { id: 19, slug: 'dubiose-lotto-und-wettbewerbsgewinne' },
  { id: 21, slug: 'allgemeine-konsumentenfallen' },
  { id: 26, slug: 'kostenpflichtige-finanzsanierungen' },
];

// Legal forms and filler words that do not identify a company (compared after folding, dots removed).
const LEGAL = new Set(['gmbh', 'ag', 'sa', 'sarl', 'sagl', 'ltd', 'llp', 'llc', 'inc', 'corp', 'co', 'kg', 'kgaa', 'ug',
  'bv', 'nv', 'sdn', 'bhd', 'plc', 'limited', 'se', 'lp', 'srl', 'spa', 'ab', 'as', 'oy', 'ev', 'pte', 'pty', 'ohg',
  'gbr', 'sl', 'sas', 'sro', 'lda', 'ltda', 'eg', 'gesmbh', 'cie', 'company', 'www']);

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ouml: 'ö', uuml: 'ü', auml: 'ä',
  Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', acirc: 'â' };

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in NAMED_ENTITIES ? NAMED_ENTITIES[n] : m));
}

function cleanText(html) {
  return decode(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return String(s).normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase();
}

/** Comparison key: case, accents, punctuation, legal form and domain ending removed. */
function coreKey(s) {
  let t = fold(s).replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/(?:\b[a-z]\.){2,}/g, (m) => m.replace(/\./g, '')); // S.A.R.L. -> sarl
  t = t.replace(/([\p{L}\p{N}])\.([a-z]{2,6})\b/gu, '$1 '); // pekiclub.com -> pekiclub
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
}

/** Keys an entry can answer to: the whole entry and each part split at commas, slashes and brackets. */
function entryKeys(name) {
  const cleaned = String(name).replace(/https?:\/\/\S+/gi, ' ');
  const parts = cleaned.split(/[,()/|]|\s[-–—]\s/);
  return [cleaned, ...parts].map(coreKey).filter(Boolean);
}

/** The text sent to the site's search: the typed name without legal-form words. Umlauts are kept. */
function searchTerm(input) {
  return input
    .split(/\s+/)
    .map((w) => w.replace(/[,()/&"„“”‚‘’«»|]+/g, '').replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((w) => w && !LEGAL.has(fold(w).replace(/[^\p{L}\p{N}]/gu, '')))
    .join(' ');
}

function parseEntries(html) {
  const out = [];
  const re = /<article>\s*<h3>([\s\S]*?)<\/h3>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ name: cleanText(m[1]), description: cleanText(m[2]).slice(0, 400) });
  }
  return out;
}

async function searchList(list, term) {
  const base = { list: list.slug, ok: false, reason: '', entries: [], excerpt: '' };
  const body = new URLSearchParams();
  body.set('tx_updkonsuminfo_konsuminfofewarnlistdetail[frmWarnlisteFilter][warnlisteID]', String(list.id));
  body.set('tx_updkonsuminfo_konsuminfofewarnlistdetail[frmWarnlisteFilter][searchtext]', term);
  let res;
  try {
    res = await fetch(SEARCH_ACTION, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ...base, reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429 || (res.status === 503 && res.headers.get('cf-mitigated'))) {
    return { ...base, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ...base, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  }
  let html;
  try {
    html = await res.text();
  } catch (err) {
    return { ...base, reason: 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
  const entries = parseEntries(html);
  if (entries.length > 0) return { ...base, ok: true, entries, excerpt: `${entries.length} entries` };
  if (/Keine\s+Eintr\S*\s+gefunden/i.test(html)) return { ...base, ok: true, entries: [], excerpt: 'no entries' };
  if (/captcha|challenge-platform|cf-chl|turnstile|access denied|zugriff verweigert/i.test(html)) {
    return { ...base, reason: 'blocked', excerpt: html.slice(0, 200) };
  }
  return { ...base, reason: 'layout_changed', excerpt: html.slice(0, 200) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword ?? '').trim();
    const term = searchTerm(input);
    const wanted = coreKey(input);
    if (!term || !wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX_URL, excerpt: 'no searchable company name in the input' };
    }

    const results = await Promise.all(LISTS.map((list) => searchList(list, term)));

    const records = [];
    const seen = new Set();
    for (const r of results) {
      if (!r.ok) continue;
      for (const e of r.entries) {
        if (!entryKeys(e.name).includes(wanted)) continue;
        const key = `${r.list}|${e.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          name: e.name,
          list: r.list,
          list_url: `https://www.ktipp.ch/service/warnlisten/detail/warnliste/${r.list}`,
          description: e.description,
        });
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: INDEX_URL,
        excerpt: records.map((x) => `${x.name} (${x.list})`).join('; ').slice(0, 500),
      };
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const first = failed[0];
      return {
        status: 'couldnt_check',
        reason: first.reason,
        records: [],
        source_url: INDEX_URL,
        excerpt: `${failed.length} of ${LISTS.length} lists could not be searched; first: ${first.list} ${first.excerpt}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: INDEX_URL,
      excerpt: `searched all ${LISTS.length} warning lists for "${term}": no matching entry`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: INDEX_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
