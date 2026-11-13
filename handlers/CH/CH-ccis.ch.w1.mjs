export const meta = {
  task: 'CH-ccis.ch',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'sector', 'location', 'street', 'postcode', 'city', 'country', 'email', 'website', 'sectors', 'types', 'categories', 'detail_url'],
  canary: { found: '2 S.p.A.', not_found: 'Ditta Inesistente Zzqxvb S.r.l.' },
};

// Member directory of Camera di Commercio Italiana per la Svizzera (ccis.ch).
// Search: https://ccis.ch/soci/?cmp=<company name>  (server-side filter, 10 entries per page, ?paged=N)
// Detail: link from each result, fields as "<p>Label: <span class="user-field-value">value</span></p>".
const BASE = 'https://ccis.ch/soci/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it,de,fr,en;q=0.8',
};
const DEADLINE_MS = 45000;
const MAX_PAGES = 10;
const MAX_DETAIL = 5;
const LEGAL = new Set(['spa', 'srl', 'sa', 'sagl', 'sarl', 'gmbh', 'ag', 'ltd', 'llc', 'inc', 'sas', 'snc', 'scarl', 'societa']);

function fold(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\./g, '');
}

/** Normalised company name: case, accents, punctuation and legal form removed. */
function normalize(str) {
  return fold(str).split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL.has(t)).join('');
}

/** The name with its legal-form words removed, for a second, wider search. */
function baseName(str) {
  return (str || '').split(/\s+/).filter((t) => t && !LEGAL.has(fold(t).replace(/[^\p{L}\p{N}]/gu, ''))).join(' ');
}

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseEntries(html) {
  return html.split('<div class="single-socio p-4">').slice(1).map((block) => {
    const link = block.match(/<div class="user-name"><h3><a href="([^"]+)">([\s\S]*?)<\/a><\/h3>/);
    if (!link) return null;
    const sector = block.match(/settore=[^"]*">([\s\S]*?)<\/a>/);
    const loc = block.match(/fa-map-marker-alt"><\/i>([\s\S]*?)<\/p>/);
    return {
      url: decode(link[1]),
      name: cleanText(link[2]),
      sector: sector ? cleanText(sector[1]) : '',
      location: loc ? cleanText(loc[1]) : '',
    };
  }).filter(Boolean);
}

function parseDetail(html) {
  const fields = {};
  const fieldRe = /<p>([^<:]{1,60}):\s*<span class="user-field-value[^"]*">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = fieldRe.exec(html))) fields[cleanText(m[1])] = cleanText(m[2]);
  const lists = {};
  const listRe = /<h[23]>([^<]{1,60})<\/h[23]>\s*<ul>([\s\S]*?)<\/ul>/g;
  while ((m = listRe.exec(html))) {
    lists[cleanText(m[1])] = [...m[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => cleanText(x[1])).filter(Boolean);
  }
  return { fields, lists };
}

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const text = res.ok ? await res.text() : '';
  return { status: res.status, text };
}

const fail = (reason, source_url, excerpt) =>
  ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const term = String(keyword ?? '').trim();
  let searchUrl = `${BASE}?cmp=${encodeURIComponent(term)}`;
  try {
    if (!normalize(term)) return fail('other', searchUrl, 'company name has no letters or digits');
    const kwNorm = normalize(term);

    // Search as typed first; if nothing matches, search again without the legal-form words.
    const queries = [term];
    const base = baseName(term);
    if (base && base !== term) queries.push(base);

    let lastSearchUrl = searchUrl;
    let lastCount = 0;
    for (const q of queries) {
      const qUrl = `${BASE}?cmp=${encodeURIComponent(q)}`;
      lastSearchUrl = qUrl;
      const entries = [];
      let complete = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (Date.now() - started > DEADLINE_MS) return fail('timeout', qUrl, 'search did not finish in time');
        const pageUrl = page === 1 ? qUrl : `${qUrl}&paged=${page}`;
        const r = await get(pageUrl);
        if (r.status === 403 || r.status === 429 || r.status === 401) return fail('blocked', pageUrl, `HTTP ${r.status}`);
        if (r.status !== 200) return fail('http_error', pageUrl, `HTTP ${r.status}`);

        const html = r.text;
        const hasList = html.includes('id="search-soci"') || html.includes('single-socio p-4');
        if (!hasList) {
          if (/cf-chl|just a moment|captcha|access denied/i.test(html)) return fail('blocked', pageUrl, 'bot check or challenge page');
          return fail('layout_changed', pageUrl, html.slice(0, 300));
        }
        entries.push(...parseEntries(html));
        if (!/class="[^"]*\bnext page-numbers\b/.test(html)) { complete = true; break; }
      }

      const matches = entries.filter((e) => normalize(e.name) === kwNorm);
      if (matches.length) {
        const records = [];
        for (let i = 0; i < matches.length; i++) {
          const e = matches[i];
          let rec = {
            name: e.name, legal_name: e.name, sector: e.sector, location: e.location,
            street: '', postcode: '', city: '', country: '', email: '', website: '',
            sectors: [], types: [], categories: [], detail_url: e.url,
          };
          if (i < MAX_DETAIL && Date.now() - started < DEADLINE_MS) {
            try {
              const d = await get(e.url);
              if (d.status === 200) {
                const { fields, lists } = parseDetail(d.text);
                rec = {
                  ...rec,
                  legal_name: fields['Ragione sociale'] || e.name,
                  street: fields['Via'] || '',
                  postcode: fields['CAP'] || '',
                  city: fields['Città'] || '',
                  country: fields['Nazione'] || '',
                  email: fields['Email'] || '',
                  website: fields['Sito Web'] || '',
                  sectors: lists['Settori'] || [],
                  types: lists['Tipologie'] || [],
                  categories: lists['Categorie'] || [],
                };
              }
            } catch (_) { /* keep the listing fields */ }
          }
          records.push(rec);
        }
        return {
          status: 'found',
          reason: '',
          records,
          source_url: qUrl,
          excerpt: `Listed: ${matches.map((m) => m.name).join('; ')} (${matches.map((m) => m.location).join('; ')})`.slice(0, 500),
        };
      }

      if (!complete) return fail('other', qUrl, `search "${q}" has more pages than the handler reads (${entries.length} entries so far)`);
      lastCount = entries.length;
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastSearchUrl,
      excerpt: `Site answered; ${lastCount} listed result(s) for "${baseName(term) || term}", none with this name`,
    };
  } catch (err) {
    return fail(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
