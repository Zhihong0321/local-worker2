export const meta = { task: 'ES-tecnoempleo.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'activity', 'province', 'company_url'],
  canary: { found: 'Indra Sistemas', not_found: 'Compañía Fantasma Zorbelia SL' } };

// Tecnoempleo's public company directory: GET clientes.php?cpais=29&nombreemp=<text>[&pagina=N]
// It is a substring search on the company name, 20 rows per page, with "Resultados a-b de N empresas" on top.
// No match at all shows "no se ha encontrado ninguna Empresa".

const BASE = 'https://www.tecnoempleo.com/clientes.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_MAX_CHARS = 40;   // the search box has maxlength 40
const START_NEW_PAGE_UNTIL_MS = 30000; // a page fetch can take 25 s, so no new page after 30 s (stays under 60 s)

// Spanish and common foreign legal forms, as lowercase letter-only words. Longest first.
const LEGAL_FORMS = [
  ['sociedad', 'limitada', 'unipersonal'], ['sociedad', 'limitada'], ['sociedad', 'anonima'], ['sociedad', 'cooperativa'],
  ['s', 'l', 'n', 'e'], ['s', 'l', 'l'], ['s', 'l', 'u'], ['s', 'a', 'u'], ['s', 'a', 's', 'u'], ['s', 'r', 'l'], ['s', 'a', 's'],
  ['s', 'p', 'a'], ['s', 'c', 'o', 'o', 'p'], ['s', 'c'], ['s', 'l'], ['s', 'a'], ['slne'], ['sll'], ['slu'], ['sau'], ['sasu'],
  ['sas'], ['srl'], ['scoop'], ['coop'], ['sl'], ['sa'], ['sc'], ['spa'], ['ltd'], ['llc'], ['inc'], ['gmbh'], ['plc'], ['corp'],
].sort((a, b) => b.length - a.length);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ccedil: 'ç', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó',
  Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü', Ccedil: 'Ç' };

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// lowercase, no accents, letters and digits only
function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Splits a company name into words. `raw` keeps the user's spelling (for the search box); `key` is the
// normalised form (no case, accents, punctuation). Legal-form words at the end are dropped, so
// "ACME TRADING SDN BHD" -> "ACME TRADING", "Indra Sistemas, S.A." -> "Indra Sistemas".
function coreWords(text) {
  const w = (text || '').trim().split(/\s+/).filter(Boolean).map((raw) => ({ raw, key: fold(raw).replace(/[^a-z0-9]/g, '') }));
  let end = w.length;
  const trimEnd = () => { while (end > 0 && !w[end - 1].key) end--; };
  let cut = true;
  while (cut) {
    cut = false;
    trimEnd();
    for (const form of LEGAL_FORMS) {
      const idx = [];
      for (let j = end - 1; j >= 0 && idx.length < form.length; j--) if (w[j].key) idx.unshift(j);
      if (idx.length !== form.length) continue;
      if (!w.slice(0, idx[0]).some((x) => x.key)) continue; // never strip the whole name
      if (!form.every((t, i) => w[idx[i]].key === t)) continue;
      end = idx[0];
      cut = true;
      break;
    }
  }
  return w.slice(0, end);
}

function nameKey(text) {
  return coreWords(text).map((x) => x.key).join('');
}

function toInt(s) {
  return parseInt(String(s).replace(/\./g, ''), 10);
}

function parsePage(html) {
  const out = { notFound: /no\s+se\s+ha\s+encontrado\s+ninguna\s+Empresa/i.test(html), start: null, end: null, total: null, rows: [] };
  const head = html.match(/Resultados\s*(?:&nbsp;|\s)*([\d.]+)\s*-\s*([\d.]+)\s*(?:&nbsp;|\s)*de\s*(?:&nbsp;|\s)*([\d.]+)/i);
  if (head) {
    out.start = toInt(head[1]);
    out.end = toInt(head[2]);
    out.total = toInt(head[3]);
  }
  const re = /<tr[^>]*class="tr_fila\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1].match(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => cleanText(x[1]));
    out.rows.push({ name: cleanText(a[2]), href: decodeEntities(a[1]), activity: cells[1] || '', province: cells[2] || '' });
  }
  return out;
}

function searchUrl(query, page) {
  const params = new URLSearchParams({ cpais: '29', nombreemp: query });
  if (page > 1) params.set('pagina', String(page));
  return `${BASE}?${params.toString()}`;
}

async function fetchHtml(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  try {
    return { html: await res.text() };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const words = coreWords(String(keyword || ''));
  const key = words.map((x) => x.key).join('');
  const query = words.map((x) => x.raw).join(' ').replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').slice(0, SEARCH_MAX_CHARS).trim();
  if (!key || !query) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
  }
  const firstUrl = searchUrl(query, 1);
  const fail = (reason, excerpt, url = firstUrl) => ({ status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 500) });

  try {
    const first = await fetchHtml(firstUrl);
    if (first.fail) return fail(first.fail, first.excerpt);

    const page1 = parsePage(first.html);
    const isNormal = page1.notFound || page1.total !== null;
    if (!isNormal) {
      const blockedMarks = /captcha|cf-chl|challenge-platform|attention required|access denied/i.test(first.html);
      return fail(blockedMarks ? 'blocked' : 'layout_changed', first.html.slice(0, 300));
    }
    if (page1.total === 0 || (page1.notFound && page1.rows.length === 0)) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `Site search for "${query}" shows no matching company (Resultados 0)` };
    }
    if (page1.start !== 1 || page1.end - page1.start + 1 !== page1.rows.length) {
      return fail('layout_changed', `expected rows ${page1.start}-${page1.end}, parsed ${page1.rows.length}`);
    }

    const matches = [];
    let matchUrl = firstUrl;
    const addMatches = (page, url) => {
      for (const row of page.rows) {
        if (nameKey(row.name) === key) {
          matches.push({ name: row.name, activity: row.activity, province: row.province, company_url: new URL(row.href, BASE).href });
          if (matches.length === 1) matchUrl = url;
        }
      }
    };
    addMatches(page1, firstUrl);

    const pages = Math.ceil(page1.total / 20);
    let complete = true;
    let stopReason = '';
    for (let p = 2; p <= pages; p++) {
      if (Date.now() - started > START_NEW_PAGE_UNTIL_MS) { complete = false; stopReason = 'time limit'; break; }
      const url = searchUrl(query, p);
      const got = await fetchHtml(url);
      if (got.fail) {
        if (matches.length) break; // matches already verified: report them, the rest is only extra detail
        return fail(got.fail, got.excerpt, url);
      }
      const page = parsePage(got.html);
      const expected = Math.min(20, page1.total - (p - 1) * 20);
      if (page.start === null || page.rows.length !== expected) {
        if (matches.length) break;
        return fail('layout_changed', `page ${p}: expected ${expected} rows, parsed ${page.rows.length}`, url);
      }
      addMatches(page, url);
    }

    const shown = `Site search for "${query}": ${page1.total} companies in total`;
    if (matches.length) {
      return { status: 'found', reason: '', records: matches, source_url: matchUrl,
        excerpt: `${shown}; matched: ${matches.map((m) => `${m.name} | ${m.activity} | ${m.province}`).join(' ; ')}`.slice(0, 500) };
    }
    if (!complete) {
      return fail('other', `${shown}; checked only part of the list (${stopReason}), no exact match yet`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
      excerpt: `${shown}; no company with this name among all of them` };
  } catch (err) {
    return fail('other', String(err?.message || err));
  }
}
