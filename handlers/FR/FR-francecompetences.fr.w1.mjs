export const meta = {
  task: 'FR-francecompetences.fr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['certifier', 'code', 'title', 'status', 'level', 'total_results'],
  canary: { found: 'CEGOS', not_found: 'Entreprise Zyxqwv Inexistante SARL' },
};

const BASE = 'https://www.francecompetences.fr/recherche-resultats/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sci', 'snc', 'scop', 'selarl', 'sel']);
const MAX_CANDIDATES = 3;

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Letters and digits only, no accents, no dots: "CEGOS S.A." -> "cegos sa". */
function tokens(name) {
  return decode(name).replace(/\./g, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function fullNorm(name) {
  return tokens(name).join(' ');
}

/** Same name without a trailing legal form: "CEGOS SA" -> "cegos". */
function coreNorm(name) {
  const t = tokens(name);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

function certifierListUrl() {
  return BASE + '?types=certification&search=&pageType=certification&active=1';
}

function certifierFilterUrl(value) {
  return BASE + '?types=certification&search=&certifier=' + encodeURIComponent(value) + '&pageType=certification&active=1';
}

async function getPage(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Certifier names offered by the site's own "Certificateur" filter. */
function certifierOptions(html) {
  const start = html.indexOf("data-query-param='certifier'");
  if (start < 0) return null;
  const end = html.indexOf('</fieldset>', start);
  const block = html.slice(start, end > start ? end : start + 300000);
  const values = [];
  for (const m of block.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/gi)) {
    const v = cleanText(m[1]);
    if (v && !values.includes(v)) values.push(v);
  }
  return values;
}

/** Result cards on a results page: one record per certification. */
function parseCards(html) {
  const hits = [...html.matchAll(/onCertificationCardClick\(event,\s*'([^']+)'\)/g)];
  const cards = [];
  hits.forEach((h, i) => {
    const chunk = html.slice(h.index, i + 1 < hits.length ? hits[i + 1].index : h.index + 8000);
    const certifier = chunk.match(/desktop__line__title">\s*Certificateur\s*<\/p>[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>/);
    const title = chunk.match(/card--results--certification--essential__content__title">([\s\S]*?)<\/h3>/);
    const status = chunk.match(/card--results--certification--essential__content__header__status[^>]*>([\s\S]*?)<\/span>/);
    const level = chunk.match(/Niveau RNCP\s*<\/p>[\s\S]*?--highlighted">([\s\S]*?)<\/span>/);
    cards.push({
      code: decode(h[1]),
      title: cleanText(title ? title[1] : ''),
      status: cleanText(status ? status[1] : ''),
      certifier: cleanText(certifier ? certifier[1] : ''),
      level: cleanText(level ? level[1] : ''),
    });
  });
  return cards;
}

function totalResults(html) {
  const m = html.match(/([\d\s  .]+)\s*résultats?/);
  return m ? m[1].replace(/[\s  .]/g, '') : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const listUrl = certifierListUrl();
  try {
    const name = String(keyword || '').trim();
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: listUrl, excerpt: 'empty company name' };
    }

    // Step 1: the site's certifier list (the "Certificateur" filter).
    const listRes = await getPage(listUrl);
    if (listRes.status === 403 || listRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: listUrl, excerpt: `HTTP ${listRes.status}` };
    }
    if (!listRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: listUrl, excerpt: `HTTP ${listRes.status}` };
    }
    const listHtml = await listRes.text();
    const options = certifierOptions(listHtml);
    if (!options || options.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: listUrl, excerpt: 'no certifier filter found on the results page' };
    }

    // Prefer the exact name (legal form included); otherwise the same name without the legal form.
    const wantFull = fullNorm(name);
    const wantCore = coreNorm(name);
    let candidates = options.filter((o) => fullNorm(o) === wantFull);
    if (candidates.length === 0) candidates = options.filter((o) => coreNorm(o) === wantCore);
    if (candidates.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: listUrl,
        excerpt: `No certifier named "${name}" in the site's certifier list (${options.length} names).`,
      };
    }

    // Step 2: one filtered results page per matching certifier name.
    const records = [];
    const notes = [];
    let firstUrl = '';
    for (const cand of candidates.slice(0, MAX_CANDIDATES)) {
      const url = certifierFilterUrl(cand);
      if (!firstUrl) firstUrl = url;
      const res = await getPage(url);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const cards = parseCards(html);
      const total = totalResults(html);
      const mine = cards.filter((c) => fullNorm(c.certifier) === fullNorm(cand));
      if (mine.length === 0) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: url,
          excerpt: `certifier "${cand}" is listed but the results page shows no matching certification cards`,
        };
      }
      notes.push(`${cand}: ${total || '?'} certifications`);
      for (const c of mine) {
        records.push({
          certifier: c.certifier,
          code: c.code,
          title: c.title,
          status: c.status,
          level: c.level,
          total_results: total,
        });
      }
    }

    const excerpt = `Certifier on the site: ${notes.join('; ')}. First page of results shown. ` +
      'This shows the organisation as a certifier of RNCP/RS certifications only; the site does not show Qualiopi certification.';
    return { status: 'found', reason: '', records, source_url: firstUrl, excerpt };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other',
      records: [],
      source_url: listUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
