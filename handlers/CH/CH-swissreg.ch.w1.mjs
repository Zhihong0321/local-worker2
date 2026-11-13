export const meta = { task: 'CH-swissreg.ch', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'id', 'number', 'title', 'doctype', 'status', 'stage', 'classes', 'representative', 'filed', 'registered', 'expires'],
  canary: { found: 'Harry Winston, Inc.', not_found: 'Nichtexistierende Musterfirma Ruritanien GmbH' } };

// Swissreg (IPI) public search: the Angular app POSTs JSON to this endpoint anonymously.
// The site rejects requests without the X-IPI-VERSION header that matches its build (build-info.json, version 11.0.6).
const BASE = 'https://www.swissreg.ch';
const SEARCH_URL = BASE + '/database/resources/query/search';
const PAGE_URL = BASE + '/database-client/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPI_VERSION = '11.0.6';
const TARGET = 'chmarke'; // trademarks (Schweizer Marken); patents and designs are other targets, not covered here
const PAGE_SIZE = 64;     // the site accepts 8/16/32/64 only

// Legal-form and filler tokens dropped before comparing names (both sides get the same treatment).
const LEGAL = new Set(['ag', 'sa', 'gmbh', 'ltd', 'limited', 'inc', 'llc', 'llp', 'plc', 'bv', 'nv', 'sarl', 'sagl',
  'kg', 'kgaa', 'co', 'corp', 'corporation', 'se', 'ug', 'ab', 'as', 'oy', 'spa', 'srl', 'sdn', 'bhd', 'pte', 'pty',
  'aktiengesellschaft', 'societe', 'anonyme', 'cie', 'the']);

function tokens(str) {
  return String(str || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // strip accents: Nestlé -> Nestle
    .toLowerCase().replace(/[.'’]/g, '')                  // S.A. -> sa, Inc. -> inc
    .replace(/[^a-z0-9ß]+/g, ' ').trim().split(' ').filter(Boolean);
}

function nameKey(str) {
  return tokens(str).filter((t) => !LEGAL.has(t)).join('');
}

const lastPart = (s) => String(s || '').split('.').pop();
const first = (arr) => (Array.isArray(arr) && arr.length ? String(arr[0]) : undefined);
const ownerName = (s) => String(s || '').split('|')[0].trim();

async function search(searchString) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'X-IPI-VERSION': IPI_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ target: TARGET, searchString, filters: {}, pageSize: PAGE_SIZE }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { status: res.status, text, ctype: res.headers.get('content-type') || '' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
    const key = nameKey(kw);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'no company name after removing legal form' };
    }
    const coreName = tokens(kw).filter((t) => !LEGAL.has(t)).join(' ');
    const queries = [`"${kw}"`];
    if (coreName && coreName !== kw.toLowerCase()) queries.push(`"${coreName}"`);

    let note = '';
    for (const searchString of queries) {
      const r = await search(searchString);
      if (r.status === 403 || r.status === 429 || /Request Rejected/i.test(r.text)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${r.status} on search ${searchString}` };
      }
      if (r.status !== 200) {
        const versionProblem = /X-IPI-VERSION/i.test(r.text);
        return { status: 'couldnt_check', reason: versionProblem ? 'layout_changed' : 'http_error', records: [], source_url: PAGE_URL,
          excerpt: `HTTP ${r.status} ${r.text.slice(0, 120)}` };
      }
      let data;
      try { data = JSON.parse(r.text); } catch { data = null; }
      if (!data || !Array.isArray(data.results)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: r.text.slice(0, 300) };
      }

      const records = [];
      const matchedOwners = new Set();
      for (const row of data.results) {
        const owners = (row.ra_inhaber__type_text_mv || []).map(ownerName).filter(Boolean);
        const hit = owners.filter((o) => nameKey(o) === key);
        if (!hit.length) continue;
        hit.forEach((o) => matchedOwners.add(o));
        records.push({
          name: hit[0],
          id: first(row.id),
          number: first(row.markennummer_formatiert__type_string),
          title: first(row.titel__type_text),
          doctype: first(row.doctype),
          status: lastPart(first(row.schutztitelstatus__type_i18n)),
          stage: lastPart(first(row.schutztitelstadium__type_i18n)),
          classes: first(row.wdlklassennummernformatiert__type_string),
          representative: row.ra_vertreter__type_text_mv ? ownerName(row.ra_vertreter__type_text_mv[0]) : undefined,
          filed: first(row.hinterlegungsdatum__type_date),
          registered: first(row.eintragungsdatum__type_date),
          expires: first(row.schutzablaufdatum__type_date),
        });
      }

      const total = Number(data.totalItems) || 0;
      if (records.length) {
        if (total > data.results.length) note = `; first ${data.results.length} of ${total} hits checked`;
        return {
          status: 'found',
          reason: '',
          records,
          source_url: PAGE_URL,
          excerpt: `Swissreg trademarks, search ${searchString}: ${total} hits; owner ${[...matchedOwners].join(' / ')}${note}`.slice(0, 500),
        };
      }
      // No exact owner match on this page. If the site has more hits than we read, we cannot say "not listed".
      if (total > data.results.length) {
        note = `search ${searchString} returned ${total} hits, only the first ${data.results.length} were read and none is this owner`;
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: note.slice(0, 500) };
      }
    }

    return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
      excerpt: `Swissreg trademark search ${queries.join(' and ')}: no owner named like "${kw}"` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
