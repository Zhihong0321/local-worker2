export const meta = { task: 'FR-boursorama.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'place', 'price', 'variation', 'url'], canary: { found: 'SOCIETE GENERALE', not_found: 'Compagnie Inexistante Zqxwv' } };

// Boursorama's own search box loads its "Valeurs" results from this partial page (a plain GET, no token).
// The partial returns a table of listed instruments (shares, funds, warrants, bonds) whose name matches the query loosely.
const BASE = 'https://www.boursorama.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms are removed from the end of a name before the exact comparison (both sides use the same rule).
const LEGAL_PHRASES = ['SOCIETE PAR ACTIONS SIMPLIFIEE', 'SOCIETE A RESPONSABILITE LIMITEE', 'SOCIETE ANONYME',
  'SOCIETE EN COMMANDITE PAR ACTIONS'];
const LEGAL_WORDS = new Set(['SA', 'SAS', 'SASU', 'SE', 'SARL', 'EURL', 'SNC', 'SCA', 'SCI', 'SCOP', 'GIE', 'SASP', 'SC',
  'LTD', 'LLC', 'INC', 'PLC', 'CORP', 'AG', 'GMBH', 'NV', 'BV', 'SPA', 'SRL', 'LIMITED', 'KGAA', 'OYJ', 'AB', 'AS']);

function normalize(str) {
  let s = (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/&/g, ' ET ').replace(/[^A-Z0-9]+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of LEGAL_PHRASES) {
      if (s.endsWith(' ' + p)) { s = s.slice(0, s.length - p.length - 1).trim(); changed = true; }
    }
    const words = s.split(' ');
    if (words.length > 1 && LEGAL_WORDS.has(words[words.length - 1])) { words.pop(); s = words.join(' '); changed = true; }
  }
  return s;
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows the runner exits the process right after this returns; a fetch socket still closing at that moment
  // trips a libuv assertion (exit code 127, answer already printed). A short wait lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const name = String(keyword || '').trim();
  const url = `${BASE}/recherche/_instruments/${encodeURIComponent(name)}`;
  if (!name) return fail('other', url, 'empty keyword');
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|challenge-platform|cf-chl|access denied/i.test(html)) return fail('blocked', url, cleanText(html).slice(0, 300));

    const table = html.match(/<table[\s\S]*?<\/table>/i);
    if (!table) {
      // The site answers with an info box when a query has no hits at all.
      if (/Aucune donn/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `site shows "Aucune donnee a afficher" for "${name}"` };
      }
      return fail('layout_changed', url, cleanText(html).slice(0, 300));
    }

    const wanted = normalize(name);
    const records = [];
    let rowCount = 0;
    for (const row of table[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(cleanText);
      if (!cells.length || !cells[0] || normalize(cells[0]) === 'LIBELLE') continue;
      rowCount++;
      if (normalize(cells[0]) !== wanted) continue;
      const href = (row.match(/href="([^"]+)"/i) || [])[1] || '';
      records.push({
        name: cells[0],
        place: cells[1] || '',
        price: cells[2] || '',
        variation: cells[3] || '',
        url: href ? new URL(href, BASE).href : '',
      });
    }

    if (!records.length) {
      return { status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `${rowCount} other listed instrument(s) returned for "${name}", none with this exact name` };
    }
    return {
      status: 'found', reason: '', records, source_url: url,
      excerpt: records.map((r) => `${r.name} | ${r.place} | ${r.price} | ${r.variation}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return fail('timeout', url, 'no answer within 25 s');
    return fail('other', url, String((err && err.message) || err));
  }
}
