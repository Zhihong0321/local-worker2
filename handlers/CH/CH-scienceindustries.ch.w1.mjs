// scienceindustries.ch: company lookup against the two public company lists the site publishes as CSV files.
//   1. Mitgliederverzeichnis (member list), https://www.scienceindustries.ch/_common/memberindex/members
//   2. Firmen & Produkte index (product index), https://www.scienceindustries.ch/_common/productindex/organisations
// The member list is checked first. The product index is checked only when the member list has no match, because it
// holds 4 companies that the member list does not (for example Erba AG, MEDA Pharma GmbH).
// A company is found only when its normalised name equals the keyword's normalised name (case, accents, punctuation
// and a trailing legal form are ignored). Similar names (e.g. "Roche" for "F. Hoffmann-La Roche AG") are not matches.

export const meta = {
  task: 'CH-scienceindustries.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'address', 'postal_code', 'city', 'phone', 'email', 'website'],
  canary: { found: 'F. Hoffmann-La Roche AG', not_found: 'Schreinerei Musterbach GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SOURCES = [
  { list: 'member_list', url: 'https://www.scienceindustries.ch/_common/memberindex/members' },
  { list: 'product_index', url: 'https://www.scienceindustries.ch/_common/productindex/organisations' },
];

// Legal-form words that are dropped from the end of a company name before comparing.
const LEGAL_FORMS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'ltd', 'inc', 'llc', 'plc', 'se', 'kg', 'sas', 'spa', 'srl', 'bv', 'nv', 'co', 'corp']);

/** Normalised name: no accents, lower case, letters and digits only, trailing legal form removed. */
function normName(s) {
  let tokens = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Semicolon CSV with double-quoted fields (quotes may contain ";" or newlines, "" is an escaped quote). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ';') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((f) => f.trim()));
}

function toRecord(header, row, list) {
  const get = (h) => {
    const i = header.indexOf(h);
    return i >= 0 && row[i] ? row[i] : '';
  };
  const address = [get('Strasse') || get('Adresse 1'), get('Adresse 2')].filter(Boolean).join(', ');
  return {
    list,
    name: row[0] || '',
    address,
    postal_code: get('PLZ'),
    city: get('Ort'),
    phone: get('Telefon'),
    email: get('Email'),
    website: get('Website'),
  };
}

/** Fetch one CSV list. Returns { ok: true, header, rows } or { ok: false, reason, excerpt }. */
async function loadList(src) {
  let res;
  try {
    res = await fetch(src.url, {
      signal: AbortSignal.timeout(25000),
      headers: { 'user-agent': UA, accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8' },
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: `${src.list}: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: 'blocked', excerpt: `${src.list}: HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', excerpt: `${src.list}: HTTP ${res.status}` };
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: `${src.list}: body read failed` };
  }
  const body = text.replace(/^﻿/, '');
  if (/^\s*<(!doctype|html)/i.test(body)) {
    return { ok: false, reason: 'layout_changed', excerpt: `${src.list}: got an HTML page, not the CSV: ${body.slice(0, 150)}` };
  }
  const rows = parseCsv(body);
  if (rows.length < 2 || rows[0][0] !== 'Firma') {
    return { ok: false, reason: 'layout_changed', excerpt: `${src.list}: CSV header not as expected: ${body.slice(0, 150)}` };
  }
  return { ok: true, header: rows[0], rows: rows.slice(1).filter((r) => r[0]) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = normName(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOURCES[0].url, excerpt: 'empty company name' };
    }

    const failures = [];
    const counts = [];
    for (const src of SOURCES) {
      const list = await loadList(src);
      if (!list.ok) {
        failures.push({ ...list, url: src.url });
        continue;
      }
      counts.push(`${src.list}: ${list.rows.length} rows`);
      const hits = list.rows
        .filter((r) => normName(r[0]) === want)
        .map((r) => toRecord(list.header, r, src.list));
      if (hits.length) {
        return {
          status: 'found',
          reason: '',
          records: hits,
          source_url: src.url,
          excerpt: hits
            .map((h) => [h.name, h.address, h.postal_code, h.city].filter(Boolean).join(' | '))
            .join(' || ')
            .slice(0, 500),
        };
      }
    }

    // No match in any list. Only a clean answer from both lists is "not found".
    if (failures.length) {
      return {
        status: 'couldnt_check',
        reason: failures[0].reason,
        records: [],
        source_url: failures[0].url,
        excerpt: failures.map((f) => f.excerpt).join(' ; ').slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SOURCES[0].url,
      excerpt: `No company with this name in ${counts.join(' and ')}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SOURCES[0].url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
