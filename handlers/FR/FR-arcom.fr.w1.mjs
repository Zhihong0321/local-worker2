export const meta = {
  task: 'FR-arcom.fr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['title', 'category', 'published', 'url'],
  canary: { found: 'Europe 1 Télécompagnie', not_found: 'Société Inexistante Zorglub SARL' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://www.arcom.fr/recherche';
const PAGE_SIZE = 10;
const MAX_PAGES = 5;
const TIME_BUDGET_MS = 30000;

const LEGAL_FORMS = new Set([
  'sas', 'sasu', 'sa', 'sarl', 'sarlu', 'eurl', 'snc', 'sci', 'sca', 'scs', 'se', 'selarl', 'selas', 'sel',
  'sc', 'ei', 'eirl', 'gie', 'societe', 'ste', 'anonyme', 'limitee', 'unipersonnelle',
]);

const ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };

/** Lower case, no accents, only letters and digits separated by single spaces. */
function fold(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/œ/gi, 'oe').replace(/æ/gi, 'ae')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The name as typed, with dotted acronyms collapsed and leading/trailing legal-form words removed. */
function cleanWords(keyword) {
  const words = String(keyword || '')
    .replace(/\b((?:[A-Za-z]\.){2,})/g, (m) => m.replace(/\./g, ''))
    .replace(/[.,;]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const isLegal = (w) => LEGAL_FORMS.has(fold(w));
  while (words.length && isLegal(words[0])) words.shift();
  while (words.length && isLegal(words[words.length - 1])) words.pop();
  return words;
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m))
    .replace(/\s+/g, ' ')
    .trim();
}

function containsSequence(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Reads one results page: the total count (null if the page is not a results page) and the rows on it. */
function parsePage(html) {
  const countMatch = html.match(/<strong>\s*(\d+)\s*<\/strong>\s*r[ée]sultat/i);
  const isEmpty = /Aucun r[ée]sultat/i.test(html);
  const total = countMatch ? Number(countMatch[1]) : (isEmpty ? 0 : null);
  const rows = [];
  for (const chunk of html.split('class="views-row"').slice(1)) {
    const a = chunk.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const dateM = chunk.match(/Publi[ée] le\s*([\s\S]*?)<\/p>/i);
    const typeM = chunk.match(/node--type-([a-z-]+)/i);
    rows.push({
      title: decode(a[2]),
      url: new URL(decode(a[1]), 'https://www.arcom.fr').href,
      category: typeM ? typeM[1] : '',
      published: dateM ? decode(dateM[1]) : '',
    });
  }
  return { total, rows };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let firstUrl = SEARCH;
  try {
    const words = cleanWords(keyword);
    const queryName = words.join(' ');
    const nameTokens = fold(queryName).split(' ').filter(Boolean);
    if (!nameTokens.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH,
               excerpt: 'no company name left after removing the legal form' };
    }

    firstUrl = `${SEARCH}?fulltext=${encodeURIComponent(queryName)}&sort_by=search_api_relevance`;
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.6' };

    let total = null;
    let scanned = 0;
    let timedOut = false;
    const matches = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      // Start no new page after 30 s, so the last 25 s fetch still ends well inside the 60 s limit.
      if (page > 0 && Date.now() - started > TIME_BUDGET_MS) { timedOut = true; break; }
      const url = page === 0 ? firstUrl : `${firstUrl}&page=${page}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const parsed = parsePage(html);
      if (parsed.total === null) {
        if (/captcha|cf-chl|challenge-platform/i.test(html)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: html.slice(0, 200) };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: html.slice(0, 300) };
      }
      if (page === 0) total = parsed.total;
      if (parsed.total === 0 || parsed.rows.length === 0) break;

      scanned += parsed.rows.length;
      for (const r of parsed.rows) {
        if (containsSequence(fold(r.title).split(' '), nameTokens)) matches.push(r);
      }
      if (scanned >= total) break;
    }

    if (matches.length) {
      const seen = new Set();
      const records = matches.filter((m) => (seen.has(m.url) ? false : seen.add(m.url)));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: records.map((m) => m.title).join(' | ').slice(0, 300),
      };
    }

    if (total === 0 || scanned >= total) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: total === 0
          ? `Aucun résultat pour "${queryName}"`
          : `${total} results for "${queryName}", none names the company in its title`,
      };
    }

    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: `${total} results for "${queryName}", checked ${scanned} (${PAGE_SIZE} per page), none names the company in its title`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: firstUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
