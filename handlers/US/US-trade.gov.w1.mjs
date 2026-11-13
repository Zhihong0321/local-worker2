// Consolidated Screening List (trade.gov, ITA). The site publishes the whole list as a public bulk file
// (consolidated.csv, ~17 MB, no key, no login). This handler downloads that file and matches the company name
// against the `name` and `alt_names` columns. The search API needs a subscription key, so it is not used.

export const meta = {
  task: 'US-trade.gov',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'alt_names', 'source', 'type', 'entity_number', 'programs', 'addresses', 'start_date', 'end_date',
    'remarks', 'source_information_url', 'federal_register_notice'],
  canary: {
    found: 'Academy of Aerospace Solid Propulsion Technology (AASPT)',
    not_found: 'Zorvex Quantum Pastry Industries LLC',
  },
};

const LIST_URL = 'https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.csv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_RECORDS = 1000; // the published list has ~26,000 rows; fewer means a truncated or changed file
const LEGAL_FORM = new Set([
  'inc', 'incorporated', 'ltd', 'limited', 'llc', 'llp', 'lp', 'corp', 'corporation', 'co', 'company', 'gmbh', 'ag',
  'sa', 'sarl', 'srl', 'spa', 'bv', 'nv', 'plc', 'pte', 'pty', 'sdn', 'bhd', 'oy', 'ab', 'as', 'kk', 'kg', 'ltda',
  'sas', 'sl', 'jsc', 'ooo', 'pjsc', 'sae', 'cv', 'doo', 'dd',
]);

/** Lower-case, strip accents and punctuation, drop trailing legal-form words. Returns '' when nothing is left. */
function normalise(str) {
  let tokens = String(str || '')
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').filter(Boolean);
  const kept = tokens.slice();
  while (tokens.length > 1 && LEGAL_FORM.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length === 0) tokens = kept;
  return tokens.join(' ');
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, line breaks inside quotes). */
function parseCsv(text) {
  const rows = [];
  const n = text.length;
  let row = [];
  let i = 0;
  while (i < n) {
    let field = '';
    if (text[i] === '"') {
      let j = i + 1;
      while (true) {
        const k = text.indexOf('"', j);
        if (k === -1) { field += text.slice(j); j = n; break; }
        field += text.slice(j, k);
        if (text[k + 1] === '"') { field += '"'; j = k + 2; } else { j = k + 1; break; }
      }
      i = j;
      // stray text after a closing quote belongs to the same field
      while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') { field += text[i]; i++; }
    } else {
      let j = i;
      while (j < n) {
        const c = text[j];
        if (c === ',' || c === '\n' || c === '\r') break;
        j++;
      }
      field = text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i >= n) { rows.push(row); break; }
    if (text[i] === ',') { i++; continue; }
    // end of row: \r\n, \n or \r
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2; else i += 1;
    rows.push(row);
    row = [];
  }
  return rows;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = clean(keyword);
    if (!query) return fail('other', LIST_URL, 'empty company name');

    let res;
    try {
      res = await fetch(LIST_URL, {
        headers: { 'User-Agent': UA, 'Accept': 'text/csv,text/plain,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return fail('timeout', LIST_URL, 'download did not finish in 25 s');
      return fail('other', LIST_URL, err && err.message ? err.message : err);
    }

    if (res.status === 403 || res.status === 429) return fail('blocked', LIST_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', LIST_URL, `HTTP ${res.status}`);

    let bytes;
    try {
      bytes = await res.arrayBuffer();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return fail('timeout', LIST_URL, 'download did not finish in 25 s');
      return fail('other', LIST_URL, 'could not read the download: ' + (err && err.message ? err.message : err));
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared !== bytes.byteLength) {
      return fail('other', LIST_URL, `incomplete download: ${bytes.byteLength} of ${declared} bytes`);
    }

    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? 500 : text.indexOf('\n')).replace(/\r$/, '');
    if (!firstLine.startsWith('_id,source,') || !/(^|,)name(,|$)/.test(firstLine) || !/(^|,)alt_names(,|$)/.test(firstLine)) {
      return fail('layout_changed', LIST_URL, firstLine || text.slice(0, 200));
    }

    const rows = parseCsv(text);
    const header = rows[0];
    const col = (name) => header.indexOf(name);
    const idx = {
      name: col('name'), alt: col('alt_names'), source: col('source'), type: col('type'),
      entity: col('entity_number'), programs: col('programs'), addresses: col('addresses'),
      start: col('start_date'), end: col('end_date'), remarks: col('remarks'),
      sourceInfo: col('source_information_url'), fr: col('federal_register_notice'),
    };
    const dataRows = rows.slice(1).filter((r) => r.length === header.length);
    if (dataRows.length < MIN_RECORDS) {
      return fail('layout_changed', LIST_URL, `only ${dataRows.length} rows parsed`);
    }

    const wanted = normalise(query);
    const records = [];
    for (const r of dataRows) {
      const names = [r[idx.name], ...String(r[idx.alt] || '').split(';')].map(clean).filter(Boolean);
      if (!names.some((nm) => normalise(nm) === wanted)) continue;
      records.push({
        name: clean(r[idx.name]),
        alt_names: String(r[idx.alt] || '').split(';').map(clean).filter(Boolean),
        source: clean(r[idx.source]),
        type: clean(r[idx.type]),
        entity_number: clean(r[idx.entity]),
        programs: clean(r[idx.programs]),
        addresses: clean(r[idx.addresses]),
        start_date: clean(r[idx.start]),
        end_date: clean(r[idx.end]),
        remarks: clean(r[idx.remarks]),
        source_information_url: clean(r[idx.sourceInfo]),
        federal_register_notice: clean(r[idx.fr]),
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No name or alternative name in ${dataRows.length} consolidated list records matches "${query}"`,
      };
    }

    const first = records[0];
    return {
      status: 'found', reason: '', records, source_url: LIST_URL,
      excerpt: `${records.length} record(s) for "${first.name}" on: ${[...new Set(records.map((x) => x.source))].join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    return fail('other', LIST_URL, err && err.message ? err.message : err);
  }
}
