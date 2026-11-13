export const meta = { task: 'ES-habitissimo.es', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'profile_url', 'list_page'],
  canary: { found: 'MAS AND PARTNERS ARQUITECTURA S.L.P.', not_found: 'Empresa Inexistente Ficticia S.L.' } };

// Habitissimo publishes an A-Z list of businesses: /empresas/lista_empresas/<letter>, then /<letter>/2, /3, ...
// (about 200 names per page; the last page is followed by repeats). Each entry is an anchor
// <a title="NAME" href="https://www.habitissimo.es/pro/SLUG">. The profile slug is not built from the name,
// so the handler reads the list and matches names instead of building URLs.

const BASE = 'https://www.habitissimo.es/empresas/lista_empresas';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 40;
const DEADLINE_MS = 50000;
const LEGAL_TOKENS = new Set(['sl', 'slp', 'sa', 'slu', 'sll', 'sc', 'scp', 'cb', 'sociedad', 'limitada', 'anonima', 'unipersonal', 'ltd']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Normalised company name: lower case, no accents, no punctuation, trailing legal form removed. */
function normName(raw) {
  const words = decodeEntities(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[.,'"`’]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && LEGAL_TOKENS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function parseEntries(html) {
  const out = [];
  const re = /<a\s+title="([^"]*)"\s+href="(https:\/\/www\.habitissimo\.es\/pro\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ name: decodeEntities(m[1]).replace(/\s+/g, ' ').trim(), href: m[2] });
  }
  const seen = new Set();
  return out.filter((e) => (seen.has(e.href) ? false : (seen.add(e.href), true)));
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const key = normName(keyword || '');
    const letter = key.charAt(0);
    if (!/^[a-z]$/.test(letter)) {
      return fail('other', BASE, `the A-Z list has no section for the first character of "${keyword}"`);
    }
    const letterUrl = `${BASE}/${letter}`;
    const signatures = new Set();
    const matches = [];
    let pagesRead = 0;
    let reachedEnd = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) {
        return fail('timeout', page === 1 ? letterUrl : `${letterUrl}/${page}`, `stopped after ${pagesRead} pages of letter ${letter}`);
      }
      const url = page === 1 ? letterUrl : `${letterUrl}/${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (res.status === 404 && page > 1) { reachedEnd = true; break; }
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (!/<title>\s*Empresas AZ/i.test(html)) {
        return fail('layout_changed', url, html.slice(0, 300));
      }
      const entries = parseEntries(html);
      if (entries.length === 0) { reachedEnd = true; break; }

      const signature = entries.map((e) => e.href).join('|');
      if (signatures.has(signature)) { reachedEnd = true; break; } // the list repeats its last page
      signatures.add(signature);
      pagesRead++;

      for (const e of entries) {
        if (normName(e.name) === key) {
          matches.push({ name: e.name, profile_url: e.href, list_page: url });
        }
      }
    }

    if (!reachedEnd) {
      return fail('other', letterUrl, `letter ${letter} has more than ${MAX_PAGES} pages; not all were read`);
    }
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matches[0].list_page,
        excerpt: `Listed on the A-Z list as "${matches[0].name}" (${matches.length} match${matches.length > 1 ? 'es' : ''}); profile: ${matches[0].profile_url}`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: letterUrl,
      excerpt: `Read ${pagesRead} pages of the A-Z list for letter ${letter}; no listed name matches "${keyword}"`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, BASE, String(err?.message || err).slice(0, 300));
  }
}
