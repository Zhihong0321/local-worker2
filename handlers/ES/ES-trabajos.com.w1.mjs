export const meta = {
  task: 'ES-trabajos.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'sector', 'location', 'description'],
  canary: { found: 'A & M Look, S.L.', not_found: 'Xqzvlorapeñaz' },
};

const BASE = 'https://www.trabajos.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 25; // the site shows 25 companies per results page
const MAX_PAGES = 4; // at most 100 search results are read per lookup
const NEW_PAGE_BEFORE_MS = 20000; // start another page only early enough to finish under 60 s
const LEGAL = new Set(['sl', 'sa', 'slu', 'sau', 'sc', 'cb', 'scp', 'slp', 'ltd', 'sociedad', 'limitada', 'anonima', 'coop']);
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  iacute: 'í', aacute: 'á', eacute: 'é', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ccedil: 'ç', agrave: 'à', egrave: 'è',
  Iacute: 'Í', Aacute: 'Á', Eacute: 'É', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
};

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (Object.prototype.hasOwnProperty.call(ENT, n) ? ENT[n] : m));
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare company names: case, accents, punctuation, spaces and the legal form (S.L., S.A., ...) do not count. */
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\./g, '')
    .split(/[^a-z0-9]+/).filter((t) => t && !LEGAL.has(t)).join('');
}

function searchUrl(keyword, offset) {
  return `${BASE}/empresas/buscar/?PALABRACLAVE=${encodeURIComponent(keyword)}&BOTONBUSCAR=Buscar${offset ? `&desde=${offset}` : ''}`;
}

function parseListings(html) {
  return html.split('<div class="listado2014_emp">').slice(1).map((chunk) => {
    const block = chunk.split('</div>')[0];
    const a = block.match(/<a href="(\/empresa\/[^"]+)"[^>]*class="empresa"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) return null;
    const field = (cls) => {
      const m = block.match(new RegExp(`<p class="${cls}">([\\s\\S]*?)</p>`));
      return m ? clean(m[1]) : '';
    };
    return {
      name: clean(a[2]),
      profile_url: new URL(a[1], BASE).href,
      sector: field('ts'),
      location: field('loc'),
      description: field('do'),
    };
  }).filter(Boolean);
}

function parseCount(html) {
  const m = html.match(/<strong>\s*([\d.\s]+?)\s*<\/strong>\s*empresas encontradas/);
  if (!m) return null;
  const n = Number(m[1].replace(/[.\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isResultsPage(html) {
  return html.includes('id="resultados2"') && html.includes('name="PALABRACLAVE"');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword ?? '').trim();
  let url = searchUrl(kw, 0);
  const firstUrl = url;
  try {
    const want = normName(kw);
    if (!want) return fail('other', url, 'the name has no letters or digits to compare');

    const matches = [];
    let total = null; // the site's own count of results, when it shows one
    let seen = 0;
    let offset = 0;
    let pages = 0;
    let lastShort = false;

    for (;;) {
      url = searchUrl(kw, offset);
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (!isResultsPage(html)) {
        if (/captcha|challenge|access denied|iniciar sesi/i.test(html)) return fail('blocked', url, 'bot check or login page');
        return fail('layout_changed', url, html.slice(0, 300));
      }

      const listings = parseListings(html);
      const count = parseCount(html);
      pages += 1;
      if (pages === 1) total = count;

      if (total !== null) {
        const expected = Math.max(0, Math.min(PAGE, total - offset));
        if (listings.length < expected) {
          return fail('layout_changed', url, `${listings.length} entries parsed, ${expected} expected`);
        }
      } else if (pages === 1 && listings.length === 0 && !/Gu(?:&iacute;|í)a de empresas/.test(html)) {
        return fail('layout_changed', url, 'no results block and no company guide heading');
      }

      for (const l of listings) {
        if (normName(l.name) === want) matches.push(l);
      }
      seen += listings.length;

      if (matches.length) {
        const m = matches[0];
        return {
          status: 'found',
          reason: '',
          records: matches,
          source_url: url,
          excerpt: `${m.name} | ${m.sector} | ${m.location}`.slice(0, 300),
        };
      }

      lastShort = listings.length < PAGE;
      offset += PAGE;
      if (total !== null && offset >= total) break;
      if (lastShort) break;
      if (pages >= MAX_PAGES || Date.now() - started >= NEW_PAGE_BEFORE_MS) break;
    }

    const complete = total !== null ? seen >= total : lastShort;
    if (complete) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `no entry matches "${kw}" among the ${seen} search results`,
      };
    }
    return fail(
      'other',
      url,
      `read ${seen} of ${total ?? 'an unknown number of'} search results; the exact name was not among them`,
    );
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, url, String((err && err.message) || err));
  }
}
