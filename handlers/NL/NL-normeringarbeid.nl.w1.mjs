export const meta = {
  task: 'NL-normeringarbeid.nl',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'kvk_number', 'address', 'activities', 'certificate_url'],
  canary: { found: '´t Hoen B.V.', not_found: 'Onbekende Zeewierkweek Holding B.V.' },
};

const BASE = 'https://www.normeringarbeid.nl/snakeurmerk/gecertificeerde-ondernemingen';
const ORIGIN = 'https://www.normeringarbeid.nl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;          // the site shows 10 results per page
const BUDGET_MS = 40000;      // stop well before the 60 s limit
const LEGAL = new Set(['bv', 'nv', 'vof', 'cv', 'commv', 'ua', 'eenmanszaak']);

const NAMED = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'", rsquo: '’', lsquo: '‘' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Company name reduced to a comparable core: no case, accents, punctuation, quotes or legal form. */
function coreName(s) {
  let t = decodeEntities(s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b([bnc])\s+v\b/g, '$1v')
    .replace(/\bv\s+o\s+f\b/g, 'vof')
    .replace(/[´`’‘'"“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const words = t.split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** A looser search string: quotes and legal form removed, because the site search is punctuation-sensitive. */
function looseQuery(keyword) {
  const words = decodeEntities(keyword).replace(/[´`’‘'"“”]/g, ' ').replace(/\./g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

function searchUrl(q, page) {
  return `${BASE}?q=${encodeURIComponent(q)}${page > 1 ? `&pagina=${page}` : ''}`;
}

function parseRows(html) {
  const chunks = html.split('class="result-row"').slice(1);
  return chunks.map((chunk) => {
    const cols = [...chunk.matchAll(/<div class="col [^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    const kvk = (cleanText(cols[2] || '').match(/KvK-nummer:\s*(\d+)/i) || [])[1] || '';
    const addrParts = (cols[1] || '').split(/<br\s*\/?>/i).map(cleanText).filter(Boolean);
    const activities = (cols[3] || '').split(/&bull;|•/).map(cleanText).filter(Boolean);
    const href = (chunk.match(/href="([^"]*\/verklaring\/[^"]*)"/i) || [])[1] || '';
    return {
      name: cleanText((cols[0] || '').match(/<strong>([\s\S]*?)<\/strong>/i)?.[1] || cols[0] || ''),
      kvk_number: kvk,
      address: addrParts.join(', '),
      activities,
      certificate_url: href ? new URL(decodeEntities(href), ORIGIN).href : '',
      _text: cleanText(chunk).slice(0, 300),
    };
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    if (!input) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };

    const started = Date.now();
    const target = coreName(input);
    if (!target) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'company name has no usable characters' };

    const queries = [input];
    const loose = looseQuery(input);
    if (loose && loose !== input) queries.push(loose);

    let firstUrl = '';
    let sawRows = 0;
    let capped = false;

    for (const q of queries) {
      const matches = [];
      let firstMatchUrl = '';
      let firstMatchText = '';

      for (let page = 1; page <= MAX_PAGES; page++) {
        if (Date.now() - started > BUDGET_MS) {
          return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl(q, page), excerpt: 'search did not finish in time' };
        }
        const url = searchUrl(q, page);
        if (!firstUrl) firstUrl = url;

        let res;
        try {
          res = await fetch(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.6' },
            signal: AbortSignal.timeout(25000),
          });
        } catch (err) {
          const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
          return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(err?.message || err).slice(0, 300) };
        }

        if (res.status === 403 || res.status === 429) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
        }
        if (!res.ok) {
          return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
        }

        const html = await res.text();
        const hasResults = html.includes('search-results');
        const hasEmpty = /Geen resultaten/i.test(html);
        if (!hasResults && !hasEmpty) {
          if (/captcha|cf-chl|access denied|attention required|verify you are human/i.test(html)) {
            return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
          }
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
        }

        const rows = hasResults ? parseRows(html) : [];
        sawRows += rows.length;

        for (const row of rows) {
          if (coreName(row.name) === target) {
            if (!firstMatchUrl) { firstMatchUrl = url; firstMatchText = row._text; }
            const { _text, ...rec } = row;
            matches.push(rec);
          }
        }

        // more pages? the pager only links to pages that exist
        const pages = [...html.matchAll(/pagina=(\d+)/g)].map((m) => Number(m[1]));
        const hasNext = pages.length > 0 && Math.max(...pages) > page;
        if (!hasNext || rows.length === 0) break;
        if (page === MAX_PAGES) capped = true;
      }

      if (matches.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: matches,
          source_url: firstMatchUrl,
          excerpt: firstMatchText,
        };
      }
      if (capped) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: `search "${q}" has more results than were checked (${MAX_PAGES * 10}); exact name not seen` };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: sawRows === 0 ? 'Geen resultaten.' : `${sawRows} other results, none with this company name`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
