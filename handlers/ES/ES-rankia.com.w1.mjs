export const meta = { task: 'ES-rankia.com', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'category', 'url', 'section'],
  canary: { found: 'Banco Santander', not_found: 'Zxqwvbnm Sociedad Limitada' } };

const BASE = 'https://www.rankia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Words that belong to a legal form ("S.A.", "S.L.U.", "Sociedad Limitada"...). The site lists brands such as
// "Banco Santander", not "BANCO SANTANDER, S.A.", so they are removed before the search and before comparing.
const LEGAL_WORDS = new Set(['s', 'a', 'l', 'u', 'sa', 'sl', 'slu', 'sau', 'sas', 'sarl', 'sociedad', 'limitada', 'anonima',
  'unipersonal', 'cooperativa', 'coop', 'sccl', 'scp', 'civil', 'ltd', 'limited', 'inc', 'llc', 'corp', 'gmbh']);

/** Lower case, no accents, no punctuation, no "(SAN)"-style brackets. */
function normalise(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isLegalWord(word) {
  const parts = normalise(word).split(' ').filter(Boolean);
  return parts.length > 0 && parts.every((p) => LEGAL_WORDS.has(p));
}

/** Drop legal-form words from the end of a name, keeping the original spelling of the rest. */
function stripLegal(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  let end = words.length;
  while (end > 1 && isLegalWord(words[end - 1])) end--;
  const kept = words.slice(0, end).join(' ').replace(/[,;:]+$/, '');
  return kept || String(name || '').trim();
}

function matchKey(name) {
  return normalise(stripLegal(name));
}

function decodeEntities(s) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = named[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Read one search results page: its result items and whether it is a normal results page. */
function readPage(html, section) {
  const title = cleanText((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const noResults = /No se han encontrado resultados/i.test(html);
  const items = [];
  for (const chunk of html.split('<a class="rnk-HoverableList_Item"').slice(1)) {
    const item = chunk.split('</a>')[0];
    const href = (item.match(/href="([^"]+)"/) || [])[1];
    const name = (item.match(/<b class="rnk-text-color-primary">([\s\S]*?)<\/b>/) || [])[1];
    const details = (item.match(/<div class="rnk-HoverableList_Details[^"]*">([\s\S]*?)<\/div>/) || [])[1];
    if (href && name) {
      items.push({ name: cleanText(name), category: cleanText(details || ''), url: new URL(decodeEntities(href), BASE).href, section });
    }
  }
  const isResultsPage = /^Resultados de /i.test(title);
  return { isResultsPage, normal: isResultsPage && (noResults || items.length > 0), noResults, items };
}

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = stripLegal(keyword);
    if (!matchKey(query)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }
    const todoUrl = `${BASE}/buscador?q=${encodeURIComponent(query)}`;
    const entityUrl = `${todoUrl}&categoria=entidades`;
    const sections = [{ section: 'todo', url: todoUrl }, { section: 'entidades', url: entityUrl }];

    const pages = await Promise.all(sections.map(async (s) => {
      try {
        const res = await fetch(s.url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
        if (res.status === 403 || res.status === 429) return { ...s, problem: 'blocked', detail: `HTTP ${res.status}` };
        if (!res.ok) return { ...s, problem: 'http_error', detail: `HTTP ${res.status}` };
        const html = await res.text();
        const page = readPage(html, s.section);
        if (page.normal) return { ...s, page };
        if (/captcha|cf-chl|challenge-platform|Just a moment/i.test(html)) return { ...s, problem: 'blocked', detail: 'bot check page' };
        return { ...s, problem: 'layout_changed', detail: html.slice(0, 300) };
      } catch (err) {
        const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return { ...s, problem: timeout ? 'timeout' : 'other', detail: String(err?.message || err).slice(0, 300) };
      }
    }));

    // Records: result items whose name equals the company name once legal forms and punctuation are removed.
    const key = matchKey(query);
    const seen = new Set();
    const records = [];
    for (const p of pages) {
      if (!p.page) continue;
      for (const item of p.page.items) {
        if (matchKey(item.name) === key && !seen.has(item.url)) {
          seen.add(item.url);
          records.push({ name: item.name, category: item.category, url: item.url, section: item.section });
        }
      }
    }
    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: todoUrl,
        excerpt: records.map((r) => `${r.name} (${r.category})`).join(' | ').slice(0, 500),
      };
    }

    // No match. "not_found" only when both searches answered normally.
    const bad = pages.find((p) => p.problem);
    if (bad) {
      return { status: 'couldnt_check', reason: bad.problem, records: [], source_url: bad.url, excerpt: bad.detail };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: todoUrl,
      excerpt: `Rankia search for "${query}": no result named "${query}" in the all-results or entities search`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `${BASE}/buscador?q=${encodeURIComponent(String(keyword || ''))}`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
