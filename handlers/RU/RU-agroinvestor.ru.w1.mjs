export const meta = { task: 'RU-agroinvestor.ru', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'slug', 'profile_url', 'description'],
  canary: { found: 'Мираторг', not_found: 'Агрофирма Несуществующая Тестовая' } };

// Agroinvestor's company reference (Справочник компаний): plain HTML lists, paginated, plus one list per first letter.
// A "found" here means the company has an entry in that reference. It is not a registry check.
const BASE = 'https://www.agroinvestor.ru';
const DIR = BASE + '/companies/a-z/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL = new Set(['ооо', 'оао', 'зао', 'ао', 'пао', 'нао', 'ип']);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
const ENTITIES = { nbsp: ' ', laquo: '«', raquo: '»', quot: '"', amp: '&', ndash: '–', mdash: '—', apos: "'", lt: '<', gt: '>' };
const FAIL_ORDER = ['blocked', 'http_error', 'timeout', 'other'];

function decode(s) {
  return s.replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ').trim();
}

// Lower-case words without punctuation and without the legal form, so "ООО «Мираторг»" and "Мираторг" compare equal.
function tokens(name) {
  return name.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((t) => t && !LEGAL.has(t));
}
const normalise = (name) => tokens(name).join('');

// Never throws. Returns { ok: true, html } or { ok: false, reason, excerpt }.
async function getPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 404 && url.includes('/letter/')) return { ok: true, html: '' }; // letter with no companies
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    return { ok: true, html: await res.text() };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
}

// slug -> listed name, from the company links on a list page.
function parseEntries(html) {
  const out = new Map();
  for (const m of html.matchAll(/<a\s[^>]*?href="\/companies\/a-z\/([^"/?#]+)\/"[^>]*>([\s\S]*?)<\/a>/g)) {
    const slug = m[1];
    if (slug === 'letter') continue;
    const name = decode(m[2]);
    if (name && !out.has(slug)) out.set(slug, name);
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword ?? '').trim();
  const want = normalise(kw);
  const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });
  if (!want) return fail('other', DIR, 'empty company name');

  try {
    const toks = tokens(kw);
    const letter = toks[0] ? toks[0][0].toUpperCase() : '';
    const letterUrl = LETTERS.includes(letter) ? `${DIR}letter/${encodeURIComponent(letter)}/` : null;

    // Page 1 gives the page count; the first-letter list is fetched at the same time.
    const [first, letterPage] = await Promise.all([getPage(DIR), letterUrl ? getPage(letterUrl) : Promise.resolve(null)]);
    if (!first.ok) return fail(first.reason, DIR, first.excerpt);
    const firstEntries = parseEntries(first.html);
    if (firstEntries.size === 0) return fail('layout_changed', DIR, first.html.slice(0, 300));

    const pageNums = [...first.html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
    const lastPage = Math.min(Math.max(1, ...pageNums), 50);
    const pageUrls = [];
    for (let p = 2; p <= lastPage; p++) pageUrls.push(`${DIR}?page=${p}`);
    const pageResults = await Promise.all(pageUrls.map(getPage));

    const entries = new Map(firstEntries);
    const failures = [];
    const absorb = (r) => {
      if (!r.ok) failures.push(r);
      else parseEntries(r.html).forEach((v, k) => { if (!entries.has(k)) entries.set(k, v); });
    };
    pageResults.forEach(absorb);
    if (letterPage) absorb(letterPage);
    const checked = 1 + pageUrls.length + (letterPage ? 1 : 0);

    const matches = [...entries].filter(([, name]) => normalise(name) === want);
    if (matches.length) {
      const records = [];
      for (const [slug, name] of matches) {
        const profile_url = `${DIR}${slug}/`;
        let description = '';
        if (Date.now() - started < 25000) { // keep the whole call under 60 s
          const p = await getPage(profile_url);
          if (p.ok) {
            const md = p.html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)
              || p.html.match(/<meta[^>]+content="([^"]*)"[^>]+name="description"/i);
            if (md) description = decode(md[1]).slice(0, 500);
          }
        }
        records.push({ name, slug, profile_url, description });
      }
      return { status: 'found', reason: '', records, source_url: records[0].profile_url,
        excerpt: (records[0].description || records[0].name).slice(0, 300) };
    }

    // No match. Only a clean read of every list may say not_found.
    if (failures.length) {
      const worst = failures.slice().sort((a, b) => FAIL_ORDER.indexOf(a.reason) - FAIL_ORDER.indexOf(b.reason))[0];
      return fail(worst.reason, DIR, `${failures.length} of ${checked} directory pages could not be read: ${worst.excerpt}`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: DIR,
      excerpt: `Not in the company directory: ${entries.size} entries read from ${checked} list pages` };
  } catch (err) {
    return fail('other', DIR, String(err?.message || err).slice(0, 300));
  }
}
