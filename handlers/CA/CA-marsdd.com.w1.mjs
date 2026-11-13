export const meta = { task: 'CA-marsdd.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'url', 'slug', 'sector', 'id'],
  canary: { found: 'Effenco', not_found: 'Société Fantôme Inexistante Québec' } };

// MaRS venture portfolio logos are public WordPress posts (type "logo"), one per company, with the company name as the title.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.marsdd.com/wp-json/wp/v2/logo';
const PER_PAGE = 100;
const MAX_PAGES = 2; // 2 requests x 25 s stays under the 60 s limit
const LEGAL = new Set(['inc', 'incorporated', 'incorporee', 'ltd', 'limited', 'limitee', 'ltee', 'corp', 'corporation',
  'corporee', 'co', 'company', 'llc', 'lp', 'ulc', 'plc', 'senc', 'sencrl', 'enr']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ').trim();
}

// Case, accents and punctuation do not count.
function fold(s) {
  return decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Normalised name without a trailing legal form (Inc, Ltd, Corp, Ltée...) or a leading "the".
function coreName(s) {
  const t = fold(s).split(' ').filter(Boolean);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  while (t.length && t[0] === 'the') t.shift();
  return t.join(' ');
}

// Names a logo title can be matched on: the whole title, the title without "(...)", and a former name in brackets.
function candidates(title) {
  const out = new Set();
  const full = coreName(title);
  if (full) out.add(full);
  const bare = coreName(title.replace(/\([^)]*\)/g, ' '));
  if (bare) out.add(bare);
  for (const m of title.matchAll(/\(([^)]*)\)/g)) {
    const former = coreName(m[1].replace(/\b(formerly|formerly known as|f\/k\/a|fka)\b/gi, ' '));
    if (former) out.add(former);
  }
  return out;
}

// The search term: the name as typed, without punctuation and a trailing legal form.
function searchTerm(keyword) {
  const words = decode(keyword).replace(/[,.;:!?"()]+/g, ' ').split(' ').filter(Boolean);
  while (words.length && LEGAL.has(fold(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  // Node on Windows aborts (exit 127, libuv assertion) when the runner exits right after a fetch; a short pause lets the socket close.
  await new Promise((r) => setTimeout(r, 300));
  return result;
}

async function lookupOnce(keyword) {
  let sourceUrl = BASE;
  try {
    const want = coreName(String(keyword ?? ''));
    if (!want) return couldnt('other', sourceUrl, 'no name left after removing punctuation and the legal form');
    const term = searchTerm(String(keyword ?? ''));
    if (!term) return couldnt('other', sourceUrl, 'no search words in the name');

    const hits = [];
    let totalPages = 1;
    for (let page = 1; page <= Math.min(MAX_PAGES, totalPages); page++) {
      const url = `${BASE}?search=${encodeURIComponent(term)}&per_page=${PER_PAGE}&page=${page}&_fields=id,slug,title,link,class_list`;
      if (page === 1) sourceUrl = url;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        if (/just a moment|challenge-platform|cf-chl/i.test(text.slice(0, 5000))) return couldnt('blocked', url, 'bot check page');
        return couldnt('layout_changed', url, text.slice(0, 200));
      }
      if (!Array.isArray(data)) return couldnt('layout_changed', url, text.slice(0, 200));
      if (page === 1) totalPages = Number(res.headers.get('x-wp-totalpages')) || 1;
      hits.push(...data);
    }

    const matches = hits.filter((h) => candidates(decode(h?.title?.rendered ?? '')).has(want));

    if (matches.length === 0) {
      if (totalPages > MAX_PAGES) {
        return couldnt('other', sourceUrl, `${totalPages} pages of search hits, only ${MAX_PAGES} checked`);
      }
      const nearest = hits.slice(0, 5).map((h) => decode(h?.title?.rendered ?? '')).join('; ');
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `${hits.length} search hits, none named "${want}"${nearest ? ': ' + nearest : ''}`.slice(0, 300),
      };
    }

    const records = matches.map((h) => ({
      id: h.id,
      name: decode(h.title.rendered),
      slug: h.slug ?? '',
      url: h.link ?? '',
      sector: ((h.class_list ?? []).find((c) => c.startsWith('venture-types-')) ?? '').slice('venture-types-'.length),
    }));
    return {
      status: 'found', reason: '', records, source_url: sourceUrl,
      excerpt: `${records[0].name} - ${records[0].url}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', sourceUrl, String(err?.message || err));
  }
}
