export const meta = {
  task: 'FR-maddyness.com',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['title', 'url', 'date', 'category', 'author', 'summary'],
  canary: { found: 'Doctolib', not_found: 'Zqxwvbtrk Entreprise Inexistante SAS' },
};

// Maddyness is a news site. It has no company register: the search page lists the articles that mention a term.
// A "found" here means the company is named in Maddyness coverage (title or summary), not that it is registered.

const BASE = 'https://www.maddyness.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped from the end of a typed name ("ACME TRADING SAS" -> "ACME TRADING").
const LEGAL = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'sci', 'snc', 'sca', 'scop', 'ei', 'eirl', 'sau', 'srl',
  'ltd', 'inc', 'gmbh', 'llc', 'plc', 'bv', 'nv', 'ag']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&([a-z]+);/gi, (m, n) => (Object.prototype.hasOwnProperty.call(NAMED, n.toLowerCase()) ? NAMED[n.toLowerCase()] : m));
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Lower case, accents and punctuation removed, so "Société Générale SA" and "societe generale sa" compare equal.
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function nameWords(keyword) {
  const words = String(keyword || '').trim().split(/\s+/).filter(Boolean);
  while (words.length && LEGAL.has(fold(words[words.length - 1]).replace(/ /g, ''))) words.pop();
  return words;
}

// "13.10.2026" -> "2026-10-13"; falls back to the /YYYY/MM/DD/ part of the article URL.
function isoDate(text, url) {
  const d = String(text || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (d) return `${d[3]}-${d[2]}-${d[1]}`;
  const u = String(url || '').match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return u ? `${u[1]}-${u[2]}-${u[3]}` : '';
}

// Result cards of the search page, only those inside the result list (not sidebars or footer).
function parseCards(html) {
  const start = html.indexOf('result_list_container');
  if (start < 0) return null;
  let body = html.slice(start);
  const end = body.indexOf('<footer');
  if (end > 0) body = body.slice(0, end);

  const cards = [];
  for (const part of body.split(/<div class="article-item\b/).slice(1)) {
    const tag = part.match(/<a\b[^>]*\barticle-item__title\b[^>]*>/);
    if (!tag) continue;
    const href = tag[0].match(/\bhref="([^"]+)"/);
    if (!href) continue;
    let url;
    try {
      url = new URL(decode(href[1]), BASE).href;
    } catch (e) {
      continue;
    }
    if (new URL(url).hostname.replace(/^www\./, '') !== 'maddyness.com') continue;

    const titleInner = part.match(/<a\b[^>]*\barticle-item__title\b[^>]*>([\s\S]*?)<\/a>/);
    const descM = part.match(/<div class="article-item__desc"[^>]*>([\s\S]*?)<\/div>/);
    const catM = part.match(/<a class="article-item__category"[^>]*>([\s\S]*?)<\/a>/);
    const authM = part.match(/<a class="article-item__author"[^>]*>([\s\S]*?)<\/a>/);
    const dateM = part.match(/<div class="article-item__date"[^>]*>([\s\S]*?)<\/div>/);

    cards.push({
      title: clean(titleInner ? titleInner[1] : ''),
      url,
      date: isoDate(dateM ? clean(dateM[1]) : '', url),
      category: clean(catM ? catM[1] : ''),
      author: clean(authM ? authM[1] : ''),
      summary: clean(descM ? descM[1] : ''),
    });
  }
  return cards;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = BASE;
  try {
    const words = nameWords(keyword);
    const core = fold(words.join(' '));
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE,
        excerpt: 'the keyword has no company name in it' };
    }

    searchUrl = `${BASE}?s=${encodeURIComponent(words.join(' '))}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const pageTitle = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
    if (/just a moment|attention required|access denied|verify you are human/i.test(pageTitle)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: clean(pageTitle).slice(0, 200) };
    }

    const cards = parseCards(html) || [];
    const emptyPage = html.includes('Aucun résultat trouvé');
    if (cards.length === 0 && !emptyPage) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl,
        excerpt: clean(html).slice(0, 300) };
    }

    const matches = cards.filter((c) => (' ' + fold(c.title + ' ' + c.summary) + ' ').includes(' ' + core + ' '));

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(({ title, url, date, category, author, summary }) => ({ title, url, date, category, author, summary })),
        source_url: searchUrl,
        excerpt: `${matches.length} Maddyness article(s) name "${words.join(' ')}": ${matches[0].title}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: cards.length
        ? `${cards.length} article(s) matched the search term, none names "${words.join(' ')}" in its title or summary`
        : `Aucun résultat trouvé for "${words.join(' ')}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
