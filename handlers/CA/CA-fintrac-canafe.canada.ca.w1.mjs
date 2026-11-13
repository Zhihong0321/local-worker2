export const meta = {
  task: 'CA-fintrac-canafe.canada.ca',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'operating_name', 'registration_number', 'status', 'services', 'address', 'website',
    'initial_registration', 'expiry_date', 'cessation_date', 'revocation_date', 'jurisdiction',
    'incorporation_number', 'incorporation_date', 'foreign_msb'],
  canary: { found: 'IMPORTATIONS GUAY LTÉE', not_found: 'SOCIÉTÉ FICTIVE DE TRANSFERTS INEXISTANTE LTÉE' },
};

// The FINTRAC MSB registry: the official downloadable list (about 9,000 rows, CSV, ~2.8 MB).
// The smaller file is used on purpose: the site is slow for some clients and the handler has 25 s per fetch.
const LIST_URL = 'https://fintrac-canafe.canada.ca/msb-esm/reg-eng.csv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped before comparing, so "Inc.", "Ltée" and "LTEE" all compare equal.
// Articles are deliberately NOT dropped: "LA BOUTIQUE" and "BOUTIQUE" are different companies.
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'ltd', 'limited', 'ltee', 'corp', 'corporation', 'co', 'company',
  'cie', 'enr', 'llc', 'lp', 'llp', 'sa', 'sas', 'sarl', 'gmbh', 'plc']);

// Column headers as the CSV writes them (some carry a trailing space or newline).
const COLUMN = {
  names: 'Organization Names (Legal and Operating)',
  address: 'Business Address',
  website: 'Website',
  services: 'Services Offered',
  status: 'MSB Registration Status',
  number: 'MSB Registration Number',
  initial: 'Date Initial MSB Registration Approval',
  expiry: 'MSB Registration Expiry Date',
  cessation: 'MSB Registration Cessation Date',
  revocation: 'MSB Registration Revocation Date',
  jurisdiction: 'Jurisdication of Incorporation',
  incNumber: 'Incorporation Number',
  incDate: 'Incorporation Date',
  foreign: 'Foreign MSB Indicator',
};

function normalize(str) {
  const words = (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.filter((w) => !LEGAL_FORMS.has(w)).join(' ');
}

// "Legal Name: X, Operating Name: Y" -> { legal: 'X', operating: 'Y' }
function splitNames(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = text.match(/^Legal Name:\s*(.*?),\s*Operating Name:\s*(.*)$/i);
  if (m) return { legal: m[1].trim(), operating: m[2].trim() };
  return { legal: text, operating: '' };
}

// RFC 4180-style parser: quoted fields may hold commas and line breaks; "" is an escaped quote.
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
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const clean = (v) => (v === undefined || v === null || v === '-' ? '' : String(v).trim());

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kwNorm = normalize(keyword);
  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/csv,text/plain,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    // The CSV is Latin-1 / Windows-1252 encoded (e.g. "QUÉBEC" is one byte 0xC9), not UTF-8.
    const text = new TextDecoder('windows-1252').decode(await res.arrayBuffer()).replace(/^﻿/, '');
    const table = parseCsv(text);
    const header = (table[0] || []).map((h) => String(h).trim());
    const at = {};
    for (const key of Object.keys(COLUMN)) {
      at[key] = header.indexOf(COLUMN[key]);
    }
    const missing = Object.keys(at).filter((k) => at[k] < 0);
    const rows = table.slice(1).filter((r) => r.length >= header.length - 1 && r.some((c) => c !== ''));
    if (missing.length > 0 || rows.length < 1000) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: `columns missing: ${missing.join(', ') || 'none'}; rows: ${rows.length}; start: ${text.slice(0, 200)}` };
    }

    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'the name has no words left after removing the legal form' };
    }

    const matches = [];
    for (const r of rows) {
      const { legal, operating } = splitNames(r[at.names]);
      if (normalize(legal) === kwNorm || (operating && normalize(operating) === kwNorm)) {
        const val = (k) => clean(r[at[k]]);
        matches.push({
          name: legal,
          operating_name: operating,
          registration_number: val('number'),
          status: val('status'),
          services: val('services'),
          address: val('address'),
          website: val('website'),
          initial_registration: val('initial'),
          expiry_date: val('expiry'),
          cessation_date: val('cessation'),
          revocation_date: val('revocation'),
          jurisdiction: val('jurisdiction'),
          incorporation_number: val('incNumber'),
          incorporation_date: val('incDate'),
          foreign_msb: val('foreign'),
        });
      }
    }

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL, excerpt: `0 registry rows match "${keyword}" (${rows.length} rows checked)` };
    }

    const first = matches[0];
    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: LIST_URL,
      excerpt: `${first.name} | ${first.registration_number} | ${first.status} (${matches.length} row(s))`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
