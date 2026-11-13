export const meta = {
  task: 'FR-viadeo.journaldunet.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'type', 'location', 'members', 'sector', 'id', 'url'],
  canary: { found: 'Renault SAS (Boulogne-Billancourt)', not_found: 'Entreprise Inexistante Lambert SARL' },
};

const BASE = 'https://viadeo.journaldunet.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
};
// Legal forms are dropped before comparing names, so "Renault SAS" matches "Renault".
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sa', 'sarl', 'eurl', 'snc', 'sci', 'scop', 'ste', 'societe']);
const NAMED = new Map(Object.entries({
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä',
  ccedil: 'ç', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', icirc: 'î', iuml: 'ï',
}));

function codePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED.get(name.toLowerCase()) ?? m);
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: no case, accents, punctuation, location in brackets or legal form. */
function core(name) {
  return (name || '')
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join('');
}

function locationOf(name) {
  const m = (name || '').match(/\(([^()]*)\)\s*$/);
  return m ? m[1].trim() : '';
}

/** Result rows of the "établissements" tab: one <li> per row, with name, type and member count. */
function parseResults(html) {
  const items = [];
  for (const chunk of html.split(/<li>\s*(?=<div class="grid_line)/).slice(1)) {
    const body = chunk.split('</li>')[0];
    const id = (body.match(/data-id="(\d+)"/) || [])[1];
    const link = body.match(/<h3>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!id || !link) continue;
    const type = cleanText((body.match(/<span class="app_list--result__search__type">([\s\S]*?)<\/span>/) || [])[1]);
    const place = cleanText((body.match(/<span class="app_list--result__search__place">([\s\S]*?)<\/span>/) || [])[1]);
    const count = place.match(/(\d[\d\s  ]*)\s*inscrit/i);
    items.push({
      id,
      name: cleanText(link[2]),
      type,
      members: count ? Number(count[1].replace(/\D/g, '')) : null,
      url: new URL(link[1], BASE).href,
      sector: '',
    });
  }
  return items;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const query = (keyword || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const wanted = core(keyword);
  const searchUrl = `${BASE}/s/?full&q=${encodeURIComponent(query)}&ty=2`;
  try {
    if (!query || !wanted) return couldnt('other', searchUrl, 'no usable words in the company name');

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return couldnt('blocked', searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) return couldnt('http_error', searchUrl, `HTTP ${res.status}`);
    if (res.url.includes('/p/login')) return couldnt('blocked', searchUrl, 'redirected to login');

    const html = await res.text();
    const items = parseResults(html);

    if (items.length === 0) {
      if (/avons pas trouv/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
          excerpt: `Nous n'avons pas trouvé de résultat pour "${query}"` };
      }
      if (/captcha|challenge-platform|cf-chl/i.test(html)) return couldnt('blocked', searchUrl, 'bot check page');
      return couldnt('layout_changed', searchUrl, html.slice(0, 200));
    }

    const matches = items.filter((it) => /entreprise/i.test(it.type) && core(it.name) === wanted);

    if (matches.length === 0) {
      // The site shows at most one page of results; if that page is full, the exact name may be further on.
      if (items.length >= 10) return couldnt('other', searchUrl, `${items.length} results, none matched, paging not confirmed`);
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${items.length} results, none is a company named "${query}"`,
      };
    }

    // Company page: the activity sector. Optional; a failure leaves the sector empty.
    for (const m of matches.slice(0, 3)) {
      if (Date.now() - started > 30000) break;
      try {
        const r = await fetch(m.url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (!r.ok) continue;
        const page = await r.text();
        const sector = page.match(/class="jActivitySectorContainer[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (sector) m.sector = cleanText(sector[1]);
      } catch {
        // keep the search-level fields
      }
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({
        name: m.name,
        type: m.type,
        location: locationOf(m.name),
        members: m.members,
        sector: m.sector,
        id: m.id,
        url: m.url,
      })),
      source_url: searchUrl,
      excerpt: matches.map((m) => `${m.name} — ${m.type}${m.members != null ? `, ${m.members} inscrits` : ''}`).join(' | ').slice(0, 300),
    };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, searchUrl, String(err?.message || err));
  }
}
