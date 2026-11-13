export const meta = {
  task: 'IE-revenue.ie',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'county', 'occupation', 'issue_type', 'total', 'additional_particulars', 'list'],
  canary: { found: 'CALL A LOCUM LIMITED', not_found: 'Cuideachta Shamhlaithe Teoranta' },
};

// Revenue publishes the defaulters lists as CSV files (two parts per quarter). The year pages list them.
const INDEX_PAGES = [
  'https://www.revenue.ie/en/corporate/press-office/list-of-defaulters/index.aspx',
  'https://www.revenue.ie/en/corporate/press-office/list-of-defaulters/index.aspx?year=2025',
  'https://www.revenue.ie/en/corporate/press-office/list-of-defaulters/index.aspx?year=2024',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words, removed only from the END of a name so both sides are compared the same way.
const LEGAL_TAIL = new Set(['LIMITED', 'LTD', 'UNLIMITED', 'COMPANY', 'CO', 'DAC', 'PLC', 'DESIGNATED', 'ACTIVITY', 'TEORANTA', 'TEO']);

/** Normalised comparison key: accents, case, punctuation, "&", brackets and legal form removed. */
function key(s) {
  const words = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && LEGAL_TAIL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** Fetch one URL as text. Never throws: returns { text, url } or { fail, status, url }. */
async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,text/csv,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', status: res.status, url };
    if (!res.ok) return { fail: 'http_error', status: res.status, url };
    return { text: await res.text(), url };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: timedOut ? 'timeout' : 'other', status: 0, url, error: String(err?.message || err).slice(0, 200) };
  }
}

/** RFC 4180-style parser: quoted fields may contain commas, "" and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, unclosed: quoted };
}

/** Returns { headers, rows } for a defaulters CSV, or null when it is not the list we expect. */
function readList(text) {
  const { rows, unclosed } = parseCsv(text.replace(/^﻿/, ''));
  if (unclosed || rows.length < 2) return null;
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
  if (!headers.includes('name')) return null;
  return { headers, rows: rows.slice(1) };
}

/** Name before any ", T/A <trading name>" part, e.g. "GDA HOSPITALITY LIMITED, T/A LITTLE ITALY". */
function legalPart(name) {
  return String(name).split(/,?\s*\bT\/A\b/i)[0];
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = key(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX_PAGES[0], excerpt: 'the keyword has no letters or digits' };
    }

    // 1. Find the list files on the year pages.
    const pages = await Promise.all(INDEX_PAGES.map(fetchText));
    const csvUrls = new Set();
    for (const p of pages) {
      if (p.fail) continue;
      for (const m of p.text.matchAll(/href=["']([^"']*\/list-of-defaulters\/[^"']*\.csv)["']/gi)) {
        csvUrls.add(new URL(m[1], 'https://www.revenue.ie').href);
      }
    }
    if (csvUrls.size === 0) {
      const failed = pages.find(p => p.fail);
      if (failed) {
        return { status: 'couldnt_check', reason: failed.fail, records: [], source_url: failed.url,
          excerpt: `list pages not read: ${pages.map(p => p.fail ? `${p.url} ${p.fail}${p.status ? ' ' + p.status : ''}` : 'ok').join('; ')}` };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: INDEX_PAGES[0],
        excerpt: 'no .csv list links found on the list-of-defaulters pages' };
    }

    // 2. Read every list file.
    const lists = await Promise.all([...csvUrls].map(fetchText));
    const records = [];
    const failures = [];
    let readOk = 0;
    let firstUrl = '';
    for (const l of lists) {
      const label = decodeURIComponent(new URL(l.url).pathname.split('/').pop());
      if (l.fail) { failures.push({ reason: l.fail, text: `${label} ${l.fail}${l.status ? ' ' + l.status : ''}` }); continue; }
      const table = readList(l.text);
      if (!table) { failures.push({ reason: 'layout_changed', text: `${label} is not the expected list` }); continue; }
      readOk++;
      const nameIdx = table.headers.indexOf('name');
      for (const row of table.rows) {
        const name = (row[nameIdx] || '').trim();
        if (!name) continue;
        if (key(legalPart(name)) !== want && key(name) !== want) continue;
        const rec = { list: label };
        table.headers.forEach((h, i) => { if (h) rec[h] = (row[i] || '').trim(); });
        records.push(rec);
        if (!firstUrl) firstUrl = l.url;
      }
    }

    // 3. Decide. A match is a match even if some list failed; no match with a failed list is never not_found.
    if (records.length > 0) {
      return {
        status: 'found', reason: '', records, source_url: firstUrl,
        excerpt: `${records.length} match(es) in the defaulters lists: ` +
          records.slice(0, 5).map(r => `${r.name} (${r.list})`).join('; '),
      };
    }
    if (failures.length > 0) {
      return {
        status: 'couldnt_check', reason: failures[0].reason, records: [], source_url: [...csvUrls][0],
        excerpt: `not found in ${readOk} of ${lists.length} lists; could not read: ${failures.map(f => f.text).join('; ')}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: [...csvUrls][0],
      excerpt: `not in the ${readOk} published defaulters lists (${[...csvUrls].length} files)`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX_PAGES[0],
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
