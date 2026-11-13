export const meta = { task: 'ES-ametic.es', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'website'], canary: { found: 'ACORDE TECHNOLOGIES S.A.', not_found: 'Empresa Inexistente Zzqx S.L.' } };

const BASE = 'https://ametic.es/quienes-somos/nuestros-asociados/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Spanish legal-form tokens. Stripped from the END of a name only, on both sides of the comparison.
const LEGAL = new Set(['s', 'a', 'l', 'u', 'sa', 'sl', 'slu', 'sau', 'sociedad', 'anonima', 'limitada', 'unipersonal']);

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&ndash;/gi, '–').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Comparable key: accents, case, punctuation, spaces and trailing legal form removed.
function key(s) {
  const t = fold(decode(s)).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join('');
}

// Search text: the name without its trailing legal form, punctuation turned into spaces.
function searchText(s) {
  const w = decode(s).replace(/[.,;:()]/g, ' ').split(/\s+/).filter(Boolean);
  let end = w.length;
  while (end > 1 && LEGAL.has(fold(w[end - 1]).replace(/[^a-z0-9]/g, ''))) end--;
  return w.slice(0, end).join(' ');
}

function cc(reason, excerpt, url) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const name = String(keyword || '').trim();
    const target = key(name);
    const q = searchText(name);
    if (!target || !q) return cc('other', 'no Latin letters or digits in the company name', '');
    searchUrl = `${BASE}?search=${encodeURIComponent(q)}`;

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return cc('blocked', `HTTP ${res.status}`, searchUrl);
    if (!res.ok) return cc('http_error', `HTTP ${res.status}`, searchUrl);

    const html = await res.text();
    const start = html.indexOf('id="asociados"');
    if (start < 0 || !/class="buscador"/.test(html)) {
      // The newsletter form loads reCAPTCHA on every page, so only a real challenge page counts as blocked.
      if (/cf-chl|Just a moment\.\.\.|<title>Attention Required/i.test(html)) return cc('blocked', 'bot check page', searchUrl);
      return cc('layout_changed', decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').slice(0, 200), searchUrl);
    }

    // Each member card: <div class="titulo"><h3><a target="_blank" href="WEBSITE">NAME</a></h3></div>
    const block = html.slice(start);
    const items = [];
    const re = /<div class="titulo"><h3><a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h3><\/div>/g;
    let m;
    while ((m = re.exec(block))) {
      items.push({
        name: decode(m[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        website: decode(m[1]).trim(),
      });
    }
    const cards = (block.match(/class="titulo"/g) || []).length;
    if (cards !== items.length) return cc('layout_changed', `${cards} member cards, ${items.length} with a readable name`, searchUrl);

    const matches = items.filter((it) => key(it.name) === target);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((it) => ({ name: it.name, website: it.website })),
        source_url: searchUrl,
        excerpt: `AMETIC member list: ${matches.map((it) => it.name).join(' | ')}`.slice(0, 300),
      };
    }
    // The search returns at most one page of cards; a full page may hide the exact name, so do not call it absent.
    if (items.length >= 30) return cc('other', `search returned ${items.length} cards; exact name not among them`, searchUrl);

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `0 AMETIC members match "${q}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timeout ? 'timeout' : 'other', String(err?.message || err), searchUrl);
  }
}
