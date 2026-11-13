export const meta = {
  task: 'IE-courts.ie',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'case_title', 'court', 'judge', 'delivered', 'published', 'neutral_citation', 'document_type', 'url'],
  canary: { found: 'Ryanair DAC', not_found: 'Fiontar Gaelach Teoranta' },
};

const BASE = 'https://judgments.courts.ie/judgments';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 20;
const MAX_PAGES = 15; // at most 300 results are read for one search
const BATCH = 4; // pages fetched at a time

// Legal-form words. Only removed from the END of a name: "Ryanair DAC" -> "ryanair".
const LEGAL_FORMS = new Set([
  'ltd', 'limited', 'dac', 'plc', 'uc', 'unlimited', 'designated', 'activity', 'company', 'clg', 'llp', 'llc',
  'inc', 'gmbh', 'srl', 'sa', 'bv', 'ag', 'teoranta', 'theoranta', 'cuideachta', 'phriobhaideach', 'priobhaidi',
  'ghniomhaiochta', 'ghniomhaiocht',
]);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

class Fail extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function failOf(e) {
  if (e instanceof Fail) return e;
  const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
  return new Fail(timeout ? 'timeout' : 'other', String(e?.message || e).slice(0, 300));
}

/** Lower case, no accents, no punctuation: "O'Regan & Co." -> "o regan and co". */
function fold(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The name without its trailing legal form. */
function coreName(text) {
  const words = fold(text).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function decode(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Judgment titles look like "Ryanair DAC (formerly Ryanair Ltd) -v- Besancon" or "O'Regan -v- Ryanair DAC".
 * Returns each party with the names it can be known by (its own name and any "formerly" name).
 */
function partiesOf(title) {
  const out = [];
  for (const side of title.split(/\s+-?v\.?-?\s+/i)) {
    const aliases = [];
    const main = side
      .replace(/\(\s*(?:formerly|trading as)\s+([^)]*)\)/gi, (_, alias) => { aliases.push(alias); return ' '; })
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+(?:&|and)\s+(?:ors?|anor|others?)\.?\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (main) out.push({ display: main, cores: [main, ...aliases].map(coreName) });
  }
  return out;
}

function parseCards(html) {
  return html.split('<li class="card">').slice(1).map((raw) => {
    const card = raw.split('</li>')[0];
    const link = card.match(/<a class="card-title" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) return null;
    const pick = (re) => {
      const m = card.match(re);
      return m ? decode(m[1]) : '';
    };
    const title = decode(link[2].replace(/<[^>]*>/g, ' '));
    return {
      title,
      url: new URL(decode(link[1]).split('?')[0], BASE).href,
      document_type: pick(/judgment-card-type">([^<]*)</),
      court: pick(/<span class="sr-only">Court: <\/span>\s*([^<]*?)\s*<\/span>/),
      judge: pick(/<span class="sr-only">Judge: <\/span>\s*([^<]*?)\s*<\/span>/),
      delivered: pick(/Delivered:\s*<time datetime="([^"]*)"/),
      published: pick(/Published:\s*<time datetime="([^"]*)"/),
      neutral_citation: pick(/Neutral citation: <\/span>\s*([^<]*?)\s*<\/span>/),
      parties: partiesOf(title),
    };
  }).filter(Boolean);
}

/** Judgment search, titles only. The company name is the search text, so the URL is built from the name. */
function searchUrl(q, page) {
  return `${BASE}?scope=title&q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;
}

async function getPage(q, page) {
  const url = searchUrl(q, page);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw failOf(e);
  }
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`);

  let html;
  try {
    html = await res.text();
  } catch (e) {
    throw failOf(e);
  }
  const count = html.match(/id="result-count">\s*([\d,]+)\s*</);
  const none = html.includes('No results match your search');
  if (!count && !none) {
    if (/captcha|challenge-platform|just a moment|access denied/i.test(html)) throw new Fail('blocked', 'bot or access check page');
    throw new Fail('layout_changed', 'results page has no result count');
  }
  return { url, total: count ? Number(count[1].replace(/,/g, '')) : 0, html };
}

function answer(status, { reason = '', records = [], source, excerpt = '' }) {
  return { status, reason, records, source_url: source, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  let core = '';
  try {
    core = coreName(name);
    if (!core) return answer('couldnt_check', { reason: 'other', source: BASE, excerpt: 'no company name given' });

    const first = await getPage(core, 1);
    const pageCount = Math.min(Math.ceil(first.total / PER_PAGE), MAX_PAGES);
    const truncated = first.total > MAX_PAGES * PER_PAGE;

    const pages = [first];
    const failures = [];
    const later = [];
    for (let p = 2; p <= pageCount; p++) later.push(p);
    for (let i = 0; i < later.length; i += BATCH) {
      const settled = await Promise.allSettled(later.slice(i, i + BATCH).map((p) => getPage(core, p)));
      for (const r of settled) {
        if (r.status === 'fulfilled') pages.push(r.value);
        else failures.push(failOf(r.reason));
      }
    }

    const seen = new Set();
    const records = [];
    for (const page of pages) {
      for (const card of parseCards(page.html)) {
        const party = card.parties.find((p) => p.cores.includes(core));
        if (!party || seen.has(card.url)) continue;
        seen.add(card.url);
        records.push({
          name: party.display,
          case_title: card.title,
          court: card.court,
          judge: card.judge,
          delivered: card.delivered,
          published: card.published,
          neutral_citation: card.neutral_citation,
          document_type: card.document_type,
          url: card.url,
        });
      }
    }

    const source = searchUrl(core, 1);
    if (records.length) {
      const r = records[0];
      return answer('found', {
        records,
        source,
        excerpt: `${records.length} judgment(s) name the company as a party; e.g. "${r.case_title}" (${r.court}, delivered ${r.delivered})`,
      });
    }
    if (failures.length) {
      return answer('couldnt_check', {
        reason: failures[0].reason,
        source,
        excerpt: `${failures.length} result page(s) could not be read: ${failures[0].message}`,
      });
    }
    if (truncated) {
      return answer('couldnt_check', {
        reason: 'other',
        source,
        excerpt: `${first.total} results for "${core}"; only the first ${MAX_PAGES * PER_PAGE} were read and none names the company as a party`,
      });
    }
    return answer('not_found', {
      source,
      excerpt: `no judgment names "${name}" as a party (${first.total} results for "${core}" checked)`,
    });
  } catch (e) {
    const f = failOf(e);
    return answer('couldnt_check', { reason: f.reason, source: searchUrl(core || name, 1), excerpt: f.message });
  }
}
