export const meta = {
  task: 'PH-marina.gov.ph',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ownership_type', 'accreditation_type', 'validity_from', 'validity_to', 'list', 'list_as_of'],
  canary: { found: '153 ISLAND REPUBLIC INC.', not_found: 'Kompanyang Hindi Nakalista sa Karagatan' },
};

// The accredited domestic shipping lists that marina.gov.ph links from its Sectoral Releases page
// (section "List of Accredited Domestic Shipping/Entities"). Each one is a Google Sheet shared by link;
// its CSV export is read here, row by row.
const LISTS = [
  { label: 'MC DS-2023-03', id: '1NZ9cHduSII_E94lEyFNEdICZdLaO35fS', gid: '149796698' },
  { label: 'MC DS-2020-02', id: '1JqPopaLcmOU995bmYGeyd9WyJe9MunnDu5bKaUzmTbI', gid: '0' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed before comparing, so "ACME TRADING INC." matches "ACME TRADING".
const LEGAL_FORMS = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'OPC', 'LLC', 'PLC', 'PTE']);

/** Comparison key: case, accents, punctuation, legal form and word order do not matter. */
function nameKey(str) {
  const s = (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  const words = s.split(' ').filter((w) => w && !LEGAL_FORMS.has(w));
  return words.sort().join(' ');
}

/** Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, commas and line breaks inside quotes. */
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
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sheetUrls(list) {
  return {
    csv: `https://docs.google.com/spreadsheets/d/${list.id}/export?format=csv&gid=${list.gid}`,
    page: `https://docs.google.com/spreadsheets/d/${list.id}/edit?gid=${list.gid}`,
  };
}

/** Reads one list. Returns { ok: true, rows, asOf } or { ok: false, reason, excerpt }. */
async function readList(list) {
  const { csv } = sheetUrls(list);
  let res;
  try {
    res = await fetch(csv, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,text/plain,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };

  const text = await res.text();
  if (/accounts\.google\.com|ServiceLogin/i.test(text.slice(0, 5000)) && !/Company Name/.test(text)) {
    return { ok: false, reason: 'blocked', excerpt: 'sheet asks for a sign-in' };
  }
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const headerIdx = rows.findIndex((r) => r[0] && r[0].trim() === 'Company Name');
  if (headerIdx < 0 || rows[headerIdx].length < 5) {
    return { ok: false, reason: 'layout_changed', excerpt: text.slice(0, 200) };
  }
  const asOfRow = rows.slice(0, headerIdx).map((r) => (r[0] || '').trim()).find((t) => /^as of /i.test(t)) || '';
  return { ok: true, rows: rows.slice(headerIdx + 1), asOf: asOfRow };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = nameKey(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    const results = await Promise.all(LISTS.map((list) => readList(list)));

    const records = [];
    const failed = [];
    results.forEach((result, i) => {
      const list = LISTS[i];
      if (!result.ok) { failed.push({ list: list.label, ...result }); return; }
      for (const r of result.rows) {
        const name = (r[0] || '').trim();
        if (!name || nameKey(name) !== wanted) continue;
        records.push({
          name,
          ownership_type: (r[1] || '').trim(),
          accreditation_type: (r[2] || '').trim(),
          validity_from: (r[3] || '').trim(),
          validity_to: (r[4] || '').trim(),
          list: list.label,
          list_as_of: result.asOf,
          source_url: sheetUrls(list).page,
        });
      }
    });

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].source_url,
        excerpt: records.map((r) => `${r.name} | ${r.accreditation_type} | ${r.validity_from} to ${r.validity_to} | ${r.list}`).join(' ;; ').slice(0, 500),
      };
    }

    // Nothing matched. That is "not listed" only if every list was actually read.
    if (failed.length) {
      const f = failed[0];
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: sheetUrls(LISTS.find((l) => l.label === f.list)).page,
        excerpt: `${failed.length} of ${LISTS.length} lists could not be read (${f.list}: ${f.excerpt})`,
      };
    }

    const total = results.reduce((n, r) => n + r.rows.length, 0);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sheetUrls(LISTS[0]).page,
      excerpt: `0 matching rows in ${total} rows of ${LISTS.length} accredited domestic shipping lists`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: '',
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
