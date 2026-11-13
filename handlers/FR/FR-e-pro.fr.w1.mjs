export const meta = {
  task: 'FR-e-pro.fr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'activity', 'detail_url', 'siren', 'siret', 'raison_sociale', 'nom_commercial'],
  canary: { found: 'Plomberie Papillon', not_found: 'Entreprise Fantome Zzqxwv' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.e-pro.fr/';
const LEGAL_FORMS = new Set(['sarl', 'sas', 'sasu', 'eurl', 'sa', 'sci', 'snc', 'sca', 'scop', 'eirl', 'ei']);
const MAX_DETAIL_FETCHES = 5;

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', hellip: '…', oelig: 'œ', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à',
  acirc: 'â', auml: 'ä', ccedil: 'ç', ocirc: 'ô', ouml: 'ö', ucirc: 'û', ugrave: 'ù', uuml: 'ü', icirc: 'î', iuml: 'ï',
  Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç',
};

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Normalised company name: case, accents, punctuation and legal form removed. */
function normalize(s) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w)).join('');
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

function visibleText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** The site is ISO-8859-1 on the search page and UTF-8 on detail pages: honour the declared charset. */
function decodeBody(buf, contentType) {
  const m = /charset=([^;\s]+)/i.exec(contentType || '');
  const label = m ? m[1].replace(/["']/g, '') : 'utf-8';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  const ct = res.headers.get('content-type') || '';
  const html = decodeBody(await res.arrayBuffer(), ct);
  return { status: res.status, html };
}

function extractDetail(text) {
  const pick = (re) => {
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  const siren = pick(/SIREN\s+(\d{3}\s?\d{3}\s?\d{3})(?!\d)/);
  const siret = pick(/SIRET\s+(\d{3}\s?\d{3}\s?\d{3}\s?\d{5})(?!\d)/);
  return {
    siren: siren ? siren.replace(/\s/g, '') : null,
    siret: siret ? siret.replace(/\s/g, '') : null,
    raison_sociale: pick(/Raison sociale\s+(.{1,120}?)\s+Nom commercial/),
    nom_commercial: pick(/Nom commercial\s+(.{1,120}?)\s+Secteur d/),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const name = String(keyword || '').trim();
    const key = normalize(name);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    // The site's search is fuzzy: send the name without its legal form, then match exactly on the results.
    const tokens = name.split(/\s+/).filter((t) => !LEGAL_FORMS.has(fold(t).replace(/[^a-z0-9]/g, '')));
    const query = tokens.join(' ') || name;
    searchUrl = `${BASE}rech?search_qui=${encodeURIComponent(query)}&search_ou=`;

    const page = await get(searchUrl);
    if (page.status === 403 || page.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${page.status}` };
    }
    if (page.status !== 200) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${page.status}` };
    }

    const h = page.html;
    const itemBlocks = h.match(/<li class="item clearfix"[\s\S]*?<\/li>/g) || [];
    const countMatch = /(\d+)\s+r.{1,3}ponses?\b/i.exec(h);
    const total = countMatch ? Number(countMatch[1]) : null;

    if (itemBlocks.length === 0 && total !== 0) {
      // A search with no hits makes the site print a PHP error page instead of an empty list.
      if (/Fatal error|Parse error/i.test(h)) {
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: 'site returned a PHP error page instead of a results list',
        };
      }
      if (/captcha|cf-chl|access denied|attention required/i.test(h)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
      }
      return {
        status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl,
        excerpt: visibleText(h).slice(0, 300),
      };
    }

    const hits = itemBlocks.map((block) => {
      const a = /<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      if (!a) return null;
      const act = /<p class="activity">([\s\S]*?)<\/p>/.exec(block);
      const adr = /<p class="adress">([\s\S]*?)<\/p>/.exec(block);
      return {
        name: visibleText(a[2]),
        detail_url: new URL(decodeEntities(a[1]), BASE).href,
        activity: act ? visibleText(act[1]) : '',
        address: adr ? visibleText(adr[1]) : '',
        text: visibleText(block).slice(0, 300),
      };
    }).filter(Boolean);

    const matches = hits.filter((x) => normalize(x.name) === key);
    if (matches.length === 0) {
      if (total === null) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: 'result count not found' };
      }
      if (total > itemBlocks.length) {
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `search shows ${itemBlocks.length} of ${total} results; the company may be beyond them`,
        };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${total} results for "${query}", none named "${name}"`,
      };
    }

    const seen = new Set();
    const unique = matches.filter((m) => (seen.has(m.detail_url) ? false : seen.add(m.detail_url)));

    const records = await Promise.all(unique.map(async (m, i) => {
      const base = { name: m.name, address: m.address, activity: m.activity, detail_url: m.detail_url };
      if (i >= MAX_DETAIL_FETCHES) return base;
      try {
        const d = await get(m.detail_url);
        if (d.status !== 200) return { ...base, detail_error: `HTTP ${d.status}` };
        return { ...base, ...extractDetail(visibleText(d.html)) };
      } catch (e) {
        return { ...base, detail_error: String(e?.name || e?.message || e).slice(0, 100) };
      }
    }));

    return {
      status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: matches[0].text,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
