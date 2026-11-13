export const meta = {
  task: 'ES-techbarcelona.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'url', 'slug', 'description', 'modified'],
  canary: { found: 'Hotelier Services Ibérica SL', not_found: 'Zorbaxtelia Inexistente SL' },
};

// Tech Barcelona's member directory (/comunidad/) is the WordPress custom post type "company".
// Its public REST endpoint searches that list: /wp-json/wp/v2/company?search=...
const BASE = 'https://www.techbarcelona.com/wp-json/wp/v2/company';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;
const BUDGET_MS = 40000;

// Legal forms. Only trailing words are removed, and dots are ignored ("S.L." = "SL").
const LEGAL = new Set([
  'sl', 'slu', 'sa', 'sau', 'slne', 'scoop', 'sccl', 'sociedad', 'limitada', 'anonima',
  'ltd', 'limited', 'inc', 'llc', 'llp', 'corp', 'gmbh', 'ag', 'bv', 'nv', 'srl', 'sas', 'sasu',
  'sarl', 'spa', 'plc', 'lda', 'unipessoal', 'kg', 'oy',
]);
const NAMED = new Map([['amp', '&'], ['quot', '"'], ['apos', "'"], ['lt', '<'], ['gt', '>'], ['nbsp', ' ']]);

function decodeEntities(s) {
  const cp = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED.get(n.toLowerCase()) ?? m);
}

function noAccents(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

// "FETALIFE TECHNOLOGIES, S.L" and "Fetalife Technologies SL" -> "fetalifetechnologies"
function matchKey(name) {
  const words = noAccents(decodeEntities(name)).toLowerCase().replace(/\./g, '').split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

// The name as typed, with punctuation and the trailing legal form removed, sent to the site's search.
function searchPhrase(name) {
  const words = decodeEntities(name).replace(/\./g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (words.length > 1 && LEGAL.has(noAccents(words[words.length - 1]).toLowerCase())) words.pop();
  return words.join(' ');
}

function plain(html, max) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let sourceUrl = '';
  try {
    const name = String(keyword || '');
    const phrase = searchPhrase(name);
    const key = matchKey(name);
    if (!phrase || !key) return fail('other', '', 'no company name given');

    const matches = [];
    let page = 1;
    let totalPages = 1;
    let seen = 0;
    do {
      const url = `${BASE}?search=${encodeURIComponent(phrase)}&per_page=100&page=${page}&_fields=id,title,link,slug,content,modified`;
      if (!sourceUrl) sourceUrl = url;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      let items;
      try {
        items = JSON.parse(text);
      } catch {
        return fail(/captcha|challenge|cf-chl|cloudflare/i.test(text) ? 'blocked' : 'layout_changed', url, text.slice(0, 200));
      }
      if (!Array.isArray(items)) return fail('layout_changed', url, text.slice(0, 200));

      totalPages = Number(res.headers.get('x-wp-totalpages')) || 1;
      seen += items.length;
      for (const item of items) {
        const title = decodeEntities(item?.title?.rendered);
        if (title && matchKey(title) === key) {
          matches.push({
            name: title,
            company_id: item.id,
            url: item.link || '',
            slug: item.slug || '',
            description: plain(item.content?.rendered, 300),
            modified: item.modified || '',
          });
        }
      }
      page++;
    } while (page <= totalPages && page <= MAX_PAGES && Date.now() - started < BUDGET_MS);

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: `${matches[0].name} ${matches[0].url}`.slice(0, 300),
      };
    }
    if (page - 1 < totalPages) {
      return fail('other', sourceUrl, `search has ${totalPages} pages of results; only ${page - 1} were checked`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `${seen} search results for "${phrase}", none with this name`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', sourceUrl, String(err?.message || err));
  }
}
