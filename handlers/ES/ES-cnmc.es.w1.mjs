// CNMC (Spain): company lookup on the site search, https://www.cnmc.es/buscador?t=NAME
// The search lists CNMC case files (expedientes). Each result title reads "CODE - Party", e.g.
// "R/AJ/391/14 - Telefónica". A company counts as found only when a case names it as the party, compared
// normalised (case, accents, punctuation, Spanish legal form). Similar words are not a match.
export const meta = {
  task: 'ES-cnmc.es',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'expediente', 'area', 'category', 'decision', 'date', 'url'],
  canary: { found: 'Telefónica', not_found: 'Empresa Inexistente Zqxwv S.L.' },
};

const SITE = 'https://www.cnmc.es';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 25;                    // the site offers 15, 20 or 25 per page
const MAX_PAGES = 4;                     // at most 100 results are read
const NO_NEW_PAGE_AFTER_MS = 30000;      // keeps the whole call well under 60 s

// Spanish legal forms at the end of a name, after fold() has removed dots and accents.
const LEGAL_FORM_END = /(?:\s+(?:sociedad anonima(?: unipersonal)?|sociedad limitada(?: unipersonal)?|s a u|s l u|s l l|s l p|s coop|scoop|s a|s l|sa|sl|sau|slu|sll|slp|ltd))+$/;

/** Lower case, no accents, no dots, single spaces, only a-z and 0-9. */
function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The name without its legal form, e.g. "Telefónica, S.A.U." -> "telefonica". */
function coreName(name) {
  return fold(name).replace(LEGAL_FORM_END, '').trim();
}

/** Plain text from an HTML fragment. */
function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One result page: the total, whether it says "no results", and its rows. Null when the layout is not what we expect. */
function parsePage(html) {
  const empty = html.includes('No se han encontrado resultados');
  const count = html.match(/<span class="negrita h3"><span>([\d.]+)<span> resultado/);
  if (!empty && !count) return null;
  const total = count ? Number(count[1].replace(/\./g, '')) : 0;
  const rows = [];
  for (const chunk of html.split('views-row').slice(1)) {
    const link = chunk.match(/<h2[^>]*>\s*<a href="(\/expedientes\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;                                   // the split also yields empty pieces
    const title = clean(link[2]);
    const parts = title.split(/\s+-\s+/);
    const hasCode = parts.length > 1;
    const area = chunk.match(/<span class="h3">([\s\S]*?)<\/span>/);
    const category = chunk.match(/<p class="gey-3 hidden-xs">([\s\S]*?)<\/p>/);
    const decision = chunk.match(/<span class="field field--name-title[^"]*">([\s\S]*?)<\/span>/);
    const date = chunk.match(/<time datetime="([^"]+)"/);
    rows.push({
      name: hasCode ? parts.slice(1).join(' - ') : title,
      expediente: hasCode ? parts[0] : '',
      area: clean(area?.[1]),
      category: clean(category?.[1]),
      decision: clean(decision?.[1]),
      date: date ? date[1].slice(0, 10) : '',
      url: SITE + link[1],
      title,
    });
  }
  return { empty, total, rows };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const core = coreName(keyword);
  const pageUrl = (page) => `${SITE}/buscador?t=${encodeURIComponent(core)}&items_per_page=${PAGE_SIZE}` + (page ? `&page=${page}` : '');
  const firstUrl = pageUrl(0);
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: firstUrl, excerpt: String(excerpt).slice(0, 300) });

  try {
    if (!core) return fail('other', 'the name has no letters to search for');

    const matches = [];
    let total = null;
    let pagesRead = 0;
    let stopReason = '';      // set when a later page could not be read
    let stopExcerpt = '';

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) {
        if (Date.now() - started > NO_NEW_PAGE_AFTER_MS) break;
        if (total !== null && page * PAGE_SIZE >= total) break;
      }

      let res;
      try {
        res = await fetch(pageUrl(page), {
          signal: AbortSignal.timeout(25000),
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
          },
        });
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        if (page === 0) return fail(timedOut ? 'timeout' : 'other', e?.message || e);
        stopReason = timedOut ? 'timeout' : 'other';
        stopExcerpt = String(e?.message || e);
        break;
      }

      if (res.status === 403 || res.status === 429) {
        if (page === 0) return fail('blocked', `HTTP ${res.status}`);
        stopReason = 'blocked'; stopExcerpt = `HTTP ${res.status}`;
        break;
      }
      if (!res.ok) {
        if (page === 0) return fail('http_error', `HTTP ${res.status}`);
        stopReason = 'http_error'; stopExcerpt = `HTTP ${res.status}`;
        break;
      }

      const html = await res.text();
      const parsed = parsePage(html);
      if (!parsed || (!parsed.empty && parsed.rows.length === 0)) {
        if (page === 0) return fail('layout_changed', html.slice(0, 300));
        stopReason = 'layout_changed'; stopExcerpt = html.slice(0, 300);
        break;
      }

      if (page === 0) {
        if (parsed.empty) {
          return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
                   excerpt: `The CNMC search for "${core}" returned no results.` };
        }
        total = parsed.total;
      }
      pagesRead++;

      for (const row of parsed.rows) {
        if (coreName(row.name) === core) {
          matches.push({ name: row.name, expediente: row.expediente, area: row.area, category: row.category,
                         decision: row.decision, date: row.date, url: row.url });
        }
      }
    }

    if (matches.length > 0) {
      const first = matches[0];
      return { status: 'found', reason: '', records: matches, source_url: firstUrl,
               excerpt: clean(`${first.expediente} - ${first.name}: ${first.decision} (${first.date})`).slice(0, 300) };
    }

    if (total !== null && pagesRead * PAGE_SIZE >= total) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
               excerpt: `None of the ${total} CNMC search results names "${core}" as a party.` };
    }

    if (stopReason) return fail(stopReason, stopExcerpt);
    return fail('other', `Read ${Math.min(pagesRead * PAGE_SIZE, total ?? 0)} of ${total} results; "${core}" is not among them, so it cannot be confirmed as unlisted.`);
  } catch (err) {
    return fail('other', String(err?.message || err));
  }
}
