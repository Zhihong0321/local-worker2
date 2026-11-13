export const meta = {
  task: 'DE-dasoertliche.de',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'street', 'postal_code', 'city', 'phone', 'detail_url', 'opening_status'],
  canary: { found: 'Siemens AG', not_found: 'Schwönfelder Nullwert Blütenkontor GmbH' },
};

const BASE = 'https://www.dasoertliche.de/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 25;          // the site lists 25 entries per page
const MAX_PAGES = 8;           // at most 200 entries read for one name
const NEW_PAGE_UNTIL_MS = 30000; // no new page is started after 30 s (each fetch can take up to 25 s)
const NO_MATCH_MARK = 'Abweichendes Suchergebnis'; // the site's own "no exact entry" notice
const LEGAL_FORMS = new Set(['gmbh', 'ag', 'kg', 'ug', 'ohg', 'gbr', 'mbh', 'co', 'kgaa', 'ev', 'se', 'eg', 'und', 'ltd', 'inc', 'llc', 'sa', 'bv', 'ab', 'as']);
const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };

function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? m;
  });
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Company name reduced for comparison: case, umlauts, punctuation and trailing legal form ignored. */
function foldName(s) {
  let t = decode(s).toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const parts = t.split(/[^a-z0-9]+/).filter(Boolean);
  const kept = [...parts];
  while (kept.length && LEGAL_FORMS.has(kept[kept.length - 1])) kept.pop();
  return (kept.length ? kept : parts).join('');
}

function sameName(a, b) {
  const fa = foldName(a);
  return fa !== '' && fa === foldName(b);
}

function pageUrl(kw, recFrom) {
  const u = new URL(BASE);
  u.searchParams.set('kw', kw);
  u.searchParams.set('ci', '');
  u.searchParams.set('form_name', 'search_nat');
  u.searchParams.set('kgs', '');
  u.searchParams.set('buab', '');
  u.searchParams.set('zbuab', '');
  if (recFrom > 1) u.searchParams.set('recFrom', String(recFrom));
  return u.href;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

async function getPage(kw, recFrom) {
  const url = pageUrl(kw, recFrom);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();
    return { url, status: res.status, html };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { url, error: fail(timeout ? 'timeout' : 'other', url, String(e?.message || e)) };
  }
}

function parseTotal(html) {
  const m = html.match(/class="sttrefferanz"[^>]*>\s*(\d+)/) || html.match(/Gesamt\s+(\d+)\s+Adressen/);
  return m ? Number(m[1]) : null;
}

function parseHits(html) {
  const hits = [];
  for (const chunk of html.split('<div class="hit "').slice(1)) {
    const h2 = chunk.match(/<h2>\s*<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!h2) continue;
    const addrHtml = (chunk.match(/<address>([\s\S]*?)<\/address>/i) || [])[1] || '';
    const lines = addrHtml.split(/<br\s*\/?>/i).map(cleanText).filter(Boolean);
    const cityIdx = lines.findIndex((l) => /^\d{5}\s/.test(l));
    const pc = cityIdx >= 0 ? lines[cityIdx].match(/^(\d{5})\s+(.*)$/) : null;
    const street = cityIdx > 0 ? lines.slice(0, cityIdx).join(', ') : '';
    hits.push({
      name: cleanText(h2[2]),
      street,
      postal_code: pc ? pc[1] : '',
      city: pc ? pc[2] : '',
      phone: cleanText((chunk.match(/<div class="phoneblock">\s*<span>([\s\S]*?)<\/span>/i) || [])[1] || ''),
      detail_url: new URL(decode(h2[1]), BASE).href,
      opening_status: cleanText((chunk.match(/<div class="hitlnk_times[^"]*">([\s\S]*?)<\/div>/i) || [])[1] || ''),
    });
  }
  return hits;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const firstUrl = pageUrl(kw, 1);
  try {
    if (!kw) return fail('other', firstUrl, 'empty company name');

    const matches = [];
    let total = null;
    let read = 0;
    let pages = 0;
    let recFrom = 1;
    let complete = false;

    for (;;) {
      const got = await getPage(kw, recFrom);
      if (got.error) return got.error;
      const { url, status, html } = got;

      const noMatchPage = html.includes(NO_MATCH_MARK);
      const hasResults = html.includes('class="hit "') || /class="sttrefferanz"/.test(html) || /Gesamt\s+\d+\s+Adressen/.test(html);

      if (status === 403 || status === 429) return fail('blocked', url, `HTTP ${status}`);
      if (!hasResults && !noMatchPage) {
        if (/captcha|Zugriff verweigert|access denied|unusual traffic/i.test(html)) return fail('blocked', url, 'bot or captcha page');
        if (status >= 400) return fail('http_error', url, `HTTP ${status}`);
        if (/Gesamt\s+0\s+Adressen|class="sttrefferanz"[^>]*>\s*0\s*</.test(html)) {
          return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: 'Gesamt 0 Adressen' };
        }
        return fail('layout_changed', url, html.slice(0, 300));
      }
      if (status >= 400 && !(noMatchPage && (status === 404 || status === 410))) return fail('http_error', url, `HTTP ${status}`);

      const hits = parseHits(html);
      if (total === null) total = parseTotal(html);
      for (const h of hits) if (sameName(h.name, kw)) matches.push(h);
      read += hits.length;
      pages += 1;

      // The site says it found no exact entry for this name: trust that, no paging needed.
      if (noMatchPage) {
        complete = true;
        break;
      }
      const lastPage = hits.length < PAGE_SIZE || (total !== null && read >= total);
      if (lastPage) {
        complete = true;
        break;
      }
      if (pages >= MAX_PAGES || Date.now() - started > NEW_PAGE_UNTIL_MS) break;
      recFrom = read + 1;
    }

    const unique = [];
    const seen = new Set();
    for (const m of matches) {
      if (!seen.has(m.detail_url)) {
        seen.add(m.detail_url);
        unique.push(m);
      }
    }

    if (unique.length) {
      const r = unique[0];
      return {
        status: 'found',
        reason: '',
        records: unique,
        source_url: firstUrl,
        excerpt: `${unique.length} exact match(es) of ${total ?? '?'} results. ${r.name}, ${r.street}, ${r.postal_code} ${r.city}, ${r.phone}`,
      };
    }
    if (complete) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl, excerpt: `${total ?? 0} results, no exact name match` };
    }
    return fail('other', firstUrl, `read ${read} of ${total ?? '?'} results over ${pages} page(s), no exact match yet; stopped at the page cap (${MAX_PAGES}) or the time limit, so cannot confirm absence`);
  } catch (err) {
    return fail('other', firstUrl, String(err?.message || err));
  }
}
