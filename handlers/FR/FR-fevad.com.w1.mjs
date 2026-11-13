export const meta = {
  task: 'FR-fevad.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'website', 'description', 'directory'],
  canary: { found: 'ABOUT YOU', not_found: 'Société Zqxvbrondelmik SARL' },
};

const BASE = 'https://www.fevad.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// The two FEVAD member directories on the public site. Both use the same GET search: ?recherche=<name>.
const DIRECTORIES = [
  { key: 'marchands', path: '/annuaires-sites-marchands/' },
  { key: 'prestataires', path: '/annuaires-prestataires/' },
];
// Legal-form words, removed from both sides before names are compared (French, English, German, Spanish, Italian, Dutch, etc.).
const LEGAL_FORMS = new Set([
  'sas', 'sasu', 'sarl', 'eurl', 'sa', 'sci', 'snc', 'sce', 'sca', 'scs', 'sprl', 'sc', 'ei', 'sarlu', 'selarl',
  'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'plc', 'llp', 'lp', 'pty', 'pte',
  'gmbh', 'ag', 'kg', 'ohg', 'bv', 'nv', 'srl', 'spa', 'sl', 'slu', 'sdn', 'bhd', 'lda', 'ab', 'oy', 'aps', 'as',
  'sro', 'kft', 'sp', 'zoo',
]);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function words(s) {
  // Dots go first so abbreviations such as "N.V." or "S.A.S." read as one word ("nv", "sas").
  return fold(s).replace(/\./g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Comparison key: lowercase, no accents, no punctuation, no legal-form words. */
function nameKey(s) {
  const kept = words(s).filter((w) => !LEGAL_FORMS.has(w));
  return (kept.length ? kept : words(s)).join('');
}

/** The search text sent to the site: the name as typed, minus legal-form words and stray punctuation. */
function searchTerm(keyword) {
  const tokens = keyword.split(/[\s,;]+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  const kept = tokens.filter((t) => !LEGAL_FORMS.has(fold(t).replace(/[^\p{L}\p{N}]/gu, '')));
  return (kept.length ? kept : tokens).join(' ') || keyword.trim();
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/** Reads the listing items of a directory results page. */
function parseItems(html) {
  const items = [];
  for (const chunk of html.split('nqannuaire_listing_item').slice(1)) {
    const block = chunk.slice(0, 2000);
    const a = block.match(/<a href="([^"]*)" title="[^"]*" class="nqmember_title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const d = block.match(/<p class="nqmember_description[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    items.push({ name: clean(a[2]), website: decode(a[1]), description: d ? clean(d[1]) : '' });
  }
  return items;
}

async function searchDirectory(dir, term) {
  const url = `${BASE}${dir.path}?recherche=${encodeURIComponent(term)}`;
  const fail = (reason, excerpt) => ({ dir, url, status: 'couldnt_check', reason, excerpt, items: [] });
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    return fail(isTimeout(err) ? 'timeout' : 'other', String(err?.message || err).slice(0, 200));
  }
  if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
  if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

  let html;
  try {
    html = await res.text();
  } catch (err) {
    return fail(isTimeout(err) ? 'timeout' : 'other', String(err?.message || err).slice(0, 200));
  }
  if (/g-recaptcha|cf-challenge|Just a moment\.\.\./i.test(html)) return fail('blocked', 'bot check page');

  const items = parseItems(html);
  const noResult = html.includes('noresult_div') || html.includes('Aucun résultat pour cette recherche');
  if (items.length === 0 && !noResult) {
    return fail('layout_changed', clean(html).slice(0, 300));
  }
  return { dir, url, status: 'ok', reason: '', excerpt: '', items };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let result;
  try {
    result = await lookupOnce(keyword);
  } catch (err) {
    result = { status: 'couldnt_check', reason: 'other', records: [], source_url: `${BASE}/annuaires-sites-marchands/`, excerpt: String(err?.message || err).slice(0, 300) };
  }
  // Let the HTTP sockets finish closing before the harness exits the process: on Node 24 / Windows,
  // exiting straight after fetch can hit a libuv assertion (exit code 127) even though the answer printed.
  await new Promise((r) => setTimeout(r, 500));
  return result;
}

async function lookupOnce(keyword) {
  try {
    const name = String(keyword ?? '').trim();
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: `${BASE}/annuaires-sites-marchands/`, excerpt: 'empty company name' };
    }
    const term = searchTerm(name);
    const key = nameKey(name);

    const results = await Promise.all(DIRECTORIES.map((dir) => searchDirectory(dir, term)));

    const matches = [];
    for (const r of results) {
      if (r.status !== 'ok') continue;
      for (const item of r.items) {
        if (nameKey(item.name) === key) matches.push({ ...item, directory: r.dir.key, url: r.url });
      }
    }

    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map((m) => ({ name: m.name, website: m.website, description: m.description, directory: m.directory })),
        source_url: first.url,
        excerpt: matches.map((m) => `${m.name}: ${m.description}`).join(' | ').slice(0, 300),
      };
    }

    const failed = results.find((r) => r.status !== 'ok');
    if (failed) {
      // A refused or broken search is never "not found": say what happened.
      return { status: 'couldnt_check', reason: failed.reason, records: [], source_url: failed.url, excerpt: failed.excerpt };
    }

    const counts = results.map((r) => `${r.dir.key}: ${r.items.length} listed result(s)`).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: results[0].url,
      excerpt: `No exact name match for "${name}" (searched "${term}") in the FEVAD directories. ${counts}.`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `${BASE}/annuaires-sites-marchands/`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
