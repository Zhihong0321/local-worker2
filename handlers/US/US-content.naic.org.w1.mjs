export const meta = {
  task: 'US-content.naic.org',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_name', 'naic_code', 'cocode', 'company_information', 'licensed_in', 'insurance_types', 'web_site', 'realm'],
  canary: { found: 'ALLSTATE INSURANCE COMPANY', not_found: 'Dezeno Insurance Company' },
};

// The NAIC "CIS Company Search" on content.naic.org is an embedded Tableau view. The view's own CSV export
// (the same data the dashboard shows) takes a COMPANY_NAME filter as a plain GET; it is a case-insensitive
// "contains" match on the company names. An empty 200 response means no company matches the filter.
const BASE = 'https://tableau.naic.org/views/CIS-WB-CompanyResults-pantheonsite-live/CompanyResultsDashboard-pantheon.csv';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_TAIL = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'plc', 'lp', 'llp', 'pc', 'pllc']);

/** Lower-case, drop parenthesised descriptors (NAIC code, "(A Captive ...)") and punctuation, then drop legal-form words from the end only. */
function coreName(str) {
  let tokens = (str || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_TAIL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** RFC 4180 style CSV parser: quoted fields may hold commas and line breaks. */
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
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let sourceUrl = '';
  try {
    const typed = String(keyword || '').trim();
    // The site matches the filter as "contains", so send the first word and match the full name locally.
    const token = typed.split(/\s+/)[0].replace(/[,;:]+$/, '');
    if (!token) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }
    sourceUrl = `${BASE}?REALM=PROD&COMPANY_NAME=${encodeURIComponent(token)}`;

    const res = await fetch(sourceUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/csv,text/plain;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }

    const body = await res.text();
    const contentType = res.headers.get('content-type') || '';
    if (/sign in|log in|captcha|verify you are human/i.test(body.slice(0, 3000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: oneLine(body).slice(0, 200) };
    }
    if (!contentType.includes('csv')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: `content-type ${contentType}: ${oneLine(body).slice(0, 200)}` };
    }
    // The site's own answer for "no company matches": a 200 CSV response with no header and no rows.
    if (body.trim() === '') {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: `0 rows for filter "${token}"` };
    }

    const rows = parseCsv(body.replace(/^﻿/, ''));
    const header = rows[0] || [];
    const col = (name) => header.indexOf(name);
    const idx = {
      cocode: col('Cocode'),
      info: col('Company Information'),
      licensed: header.findIndex((h) => h.startsWith('Company Licensed In')),
      name: col('Company Name'),
      types: col('Insurance Types'),
      web: col('Web Site'),
      full: col('Full Company Name'),
      realm: col('REALM'),
    };
    if (idx.cocode < 0 || idx.name < 0 || idx.full < 0 || idx.licensed < 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: oneLine(header.join(',')).slice(0, 300) };
    }

    const target = coreName(typed);
    const records = [];
    for (const r of rows.slice(1)) {
      if (r.length < header.length) continue;
      const shownName = r[idx.name] || '';
      const fullName = r[idx.full] || '';
      if (coreName(fullName) !== target && coreName(shownName) !== target) continue;
      const code = (shownName.match(/NAIC Company Code\s*(\d+)/i) || [])[1] || '';
      records.push({
        name: oneLine(fullName),
        company_name: oneLine(shownName.replace(/\(NAIC Company Code[^)]*\)/i, '')),
        naic_code: code,
        cocode: oneLine(r[idx.cocode]),
        company_information: oneLine(r[idx.info]),
        licensed_in: oneLine(r[idx.licensed]),
        insurance_types: oneLine(r[idx.types]),
        web_site: oneLine(r[idx.web]),
        realm: oneLine(r[idx.realm]),
      });
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: `${rows.length - 1} rows for filter "${token}", none named "${typed}"` };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: records.map((r) => `${r.name} (NAIC ${r.naic_code})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: sourceUrl || BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
