export const meta = {
  task: 'DE-berlin-partner.de',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'subtitle', 'address', 'website', 'description'],
  canary: { found: 'Amazon Deutschland', not_found: 'Zwiebelfeld Sonnenschirm Verwaltungs GmbH' },
};

// Berlin-Partner network list (TYPO3). The page has a "Firmennname eingeben" search box:
// GET ?search=<name> returns server-rendered HTML with one <div class='partnerbox'> per match,
// 30 per page, next page via &pointer=30, 60, ... An empty result says "Keinen Eintrag gefunden."
const BASE = 'https://www.berlin-partner.de/netzwerk/berlin-partner';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 30;
const MAX_PAGES = 10;
const BUDGET_MS = 30000; // worst case: 30 s of pages + one 25 s fetch stays under 60 s

// Legal-form and connector tokens ignored when comparing names (case, punctuation and legal form only).
const LEGAL = new Set(['gmbh', 'ag', 'se', 'kg', 'ev', 'gbr', 'gbh', 'mbh', 'ug', 'ohg', 'plc', 'co', 'ltd', 'inc', 'eg', 'kgaa', 'und', 'and']);

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };

function decode(s) {
  return (s || '')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in NAMED ? NAMED[n] : m))
    .replace(/\s+/g, ' ')
    .replace(/(,\s*)+/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

function unJs(s) {
  return (s || '').replace(/\\(["\\/])/g, '$1').replace(/\\n/g, ' ');
}

function normalise(s) {
  const t = decode(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/e\.\s*v\./g, 'ev')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return t.split(/[^a-z0-9]+/).filter((tok) => tok && !LEGAL.has(tok)).join('');
}

function parseRows(html) {
  const rows = [];
  for (const part of html.split("<div class='partnerbox").slice(1)) {
    const nameM = part.match(/<div class='pname'>([\s\S]*?)<\/div>/);
    if (!nameM) continue;
    const idM = part.match(/partnertitel\[(\d+)\]/);
    const id = idM ? idM[1] : null;
    const field = (key) => {
      if (!id) return '';
      const m = part.match(new RegExp(key + '\\[' + id + '\\]="((?:[^"\\\\]|\\\\.)*)"'));
      return m ? decode(unJs(m[1])) : '';
    };
    rows.push({
      name: decode(nameM[1]),
      subtitle: field('partneruntertitel'),
      address: field('partneradresse'),
      website: field('partnerlink'),
      description: field('partnerbeschreibung').slice(0, 500),
    });
  }
  return rows;
}

const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const query = String(keyword ?? '').trim();
  const firstUrl = `${BASE}?search=${encodeURIComponent(query)}`;
  try {
    const want = normalise(query);
    if (!query || !want) return fail('other', BASE, 'empty or unusable company name');

    const seen = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - started > BUDGET_MS) return fail('other', firstUrl, `search paging stopped after ${seen.length} entries (time budget)`);
      const pointer = page * PAGE;
      const url = pointer === 0 ? firstUrl : `${firstUrl}&pointer=${pointer}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (!(html.includes('partner-search-form') && html.includes('diepartnerliste'))) {
        return fail('layout_changed', url, html.slice(0, 300));
      }
      const empty = html.includes('Keinen Eintrag gefunden');
      const rows = parseRows(html);
      if (rows.length === 0 && !empty) return fail('layout_changed', url, 'no partner entries and no empty-result text');

      const records = [];
      for (const r of rows) {
        for (const part of r.name.split('|').map((p) => p.trim())) {
          if (normalise(part) === want) records.push({ ...r, name: part });
        }
      }
      if (records.length) {
        return {
          status: 'found',
          reason: '',
          records,
          source_url: url,
          excerpt: records.map((r) => [r.name, r.subtitle, r.address].filter(Boolean).join(' | ')).join(' ;; ').slice(0, 500),
        };
      }

      seen.push(...rows.map((r) => r.name));
      if (empty || rows.length < PAGE) {
        const similar = seen.slice(0, 5).join('; ');
        return {
          status: 'not_found',
          reason: '',
          records: [],
          source_url: firstUrl,
          excerpt: seen.length
            ? `No entry named "${query}" among ${seen.length} search results. Closest: ${similar}`
            : 'Keinen Eintrag gefunden.',
        };
      }
    }
    return fail('other', firstUrl, `${seen.length} results and no exact name match within ${MAX_PAGES} pages`);
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, firstUrl, String(err?.message || err).slice(0, 300));
  }
}
