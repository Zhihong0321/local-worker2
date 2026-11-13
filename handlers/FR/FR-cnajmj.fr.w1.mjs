export const meta = {
  task: 'FR-cnajmj.fr',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'city', 'team'],
  canary: { found: 'SELARL SANTUCCI', not_found: 'Société Fictive Introuvable SARL' },
};

// The CNAJMJ studies directory: one public HTML page that lists every study (étude) with its name.
// Each study has its own page with its city and team. Practitioners (people) are not companies and are not matched.
const LIST_URL = 'https://www.cnajmj.fr/etudes/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
};
const LEGAL_FORMS = new Set(['selarl', 'selas', 'selafa', 'selarlu', 'selasu', 'sasu', 'sarl', 'eurl', 'sas', 'sa', 'scp', 'scm', 'sci', 'societe']);

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"');
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Case, accents, punctuation and legal form removed: "SELARL Santucci" and "Santucci" both become "santucci". */
function normalize(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((t) => t && !LEGAL_FORMS.has(t)).join('');
}

function parseList(html) {
  const out = [];
  const re = /<a href="(https:\/\/www\.cnajmj\.fr\/etude\/[^"]+)" class="item[^"]*">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const nameHtml = m[2].match(/<div class="nom">\s*<h4>([\s\S]*?)<\/h4>/);
    const name = nameHtml ? clean(nameHtml[1]) : '';
    if (name) out.push({ name, url: m[1] });
  }
  return out;
}

function parseDetail(html) {
  const city = [];
  const imp = html.match(/<h4>\s*Implantation\s*<\/h4>([\s\S]*?)<\/ul>/);
  if (imp) {
    for (const a of imp[1].matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)) {
      const t = clean(a[1]);
      if (t) city.push(t);
    }
  }
  const team = [];
  const block = (html.split('equipe-dediee wow')[1] || '').split('office-etude')[0];
  for (const p of block.matchAll(/<div class="nom">\s*<h4>([\s\S]*?)<\/h4>\s*<\/div>\s*<div class="status">\s*<span>([\s\S]*?)<\/span>/g)) {
    team.push({ name: clean(p[1]), status: clean(p[2]) });
  }
  return { city, team };
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(LIST_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (html.includes('Just a moment') || html.includes('cf-chl')) return couldnt('blocked', 'bot check page');

    const list = parseList(html);
    if (list.length === 0) return couldnt('layout_changed', 'no studies found on the studies page');

    const want = normalize(keyword || '');
    const match = want ? list.find((s) => normalize(s.name) === want) : null;
    if (!match) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `${list.length} studies listed; none named "${keyword}"`,
      };
    }

    // The studies page proves the match. The study's own page adds city and team; if it fails, the record stays.
    let city = [];
    let team = [];
    try {
      const d = await fetch(match.url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (d.ok) {
        const parsed = parseDetail(await d.text());
        city = parsed.city;
        team = parsed.team;
      }
    } catch (_) {
      // detail page optional
    }

    return {
      status: 'found',
      reason: '',
      records: [{ name: match.name, url: match.url, city, team }],
      source_url: LIST_URL,
      excerpt: `${match.name} — listed on the CNAJMJ studies page${city.length ? ' (' + city.join(', ') + ')' : ''}`,
    };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return couldnt(reason, String((err && err.message) || err).slice(0, 300));
  }
}
