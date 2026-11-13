export const meta = {
  task: 'NZ-aviation.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'source', 'certificate_type', 'address', 'city_or_town', 'country', 'registration_mark', 'manufacturer', 'model', 'serial_no', 'registered_on'],
  canary: { found: 'Air Napier Limited', not_found: 'Te Whare Rangi Manu Limited' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The three public sources this handler reads. Part 119 and Part 145 holders are embedded in the list pages;
// the aircraft register is the public CSV download linked from /aircraft/aircraft-registration/aircraft-register-search/.
const SOURCES = [
  { kind: 'cert', source: 'Part 119 Air Operator Certificate list', url: 'https://www.aviation.govt.nz/licensing-and-certification/operators/list-of-certificated-organisations/p119/' },
  { kind: 'cert', source: 'Part 145 Maintenance Organisation list', url: 'https://www.aviation.govt.nz/licensing-and-certification/operators/list-of-certificated-organisations/p145/' },
  { kind: 'csv', source: 'Aircraft register (owner name)', url: 'https://www.aviation.govt.nz/assets/aircraft/aircraft-register/Aircraft-Register-for-website.csv' },
];

// Words that describe a legal form, not the company. Removed from both sides before comparing.
const LEGAL_FORM = new Set(['limited', 'ltd', 'inc', 'incorporated', 'lp', 'partnership', 'llc', 'company', 'co']);

const FAILURE_ORDER = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&');
}

// The list pages hold their data as JavaScript strings, so \xHH, \uHHHH and \" escapes appear inside them.
function unescapeJs(s) {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["\\/])/g, '$1');
}

function clean(s) {
  return decodeEntities(unescapeJs(s || '')).replace(/\s+/g, ' ').trim();
}

// Normalised comparison key: no accents, no case, no punctuation, "&" = "and", legal form removed.
function nameKey(s) {
  const words = clean(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORM.has(w));
  return words.join('');
}

// Fetch one source. Never throws; returns { ok, text } or { ok: false, reason, excerpt }.
async function getText(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,text/csv,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  }
  try {
    const text = await res.text();
    if (/captcha|Just a moment\.\.\.|cf-chl-|Attention Required/i.test(text.slice(0, 20000)) && !/"CertificateType"|Owner Name/.test(text)) {
      return { ok: false, reason: 'blocked', excerpt: 'bot check page' };
    }
    return { ok: true, text };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) };
  }
}

// Certificate holders: each row is {"Name": "...", "CertificateType": "...", "Address": "...", "CityOrTown": "...", "Country": "..."}
// Returns null when the number of rows found does not equal the number of row openers in the page (layout changed).
function parseCerts(html) {
  const opener = (html.match(/\{"Name":/g) || []).length;
  const re = /\{"Name": "((?:[^"\\]|\\.)*)", "CertificateType": "((?:[^"\\]|\\.)*)", "Address": "((?:[^"\\]|\\.)*)", "CityOrTown": "((?:[^"\\]|\\.)*)", "Country": "((?:[^"\\]|\\.)*)"\}/g;
  const rows = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    rows.push({
      name: clean(m[1]),
      certificate_type: clean(m[2]),
      address: clean(m[3]),
      city_or_town: clean(m[4]),
      country: clean(m[5]),
    });
  }
  if (opener === 0 || rows.length !== opener) return null;
  return rows;
}

// Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, quoted line breaks).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Aircraft register CSV: one row per registered aircraft, with the owner's name and address.
// Returns null when the expected columns are not in the header (layout changed).
function parseRegister(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const idx = {
    owner: col('Owner Name'),
    address: col('Owner Address'),
    mark: col('Registration Mark'),
    manufacturer: col('Manufacturer'),
    model: col('Model'),
    serial: col('Serial No.'),
    registered: col('Registered on'),
  };
  if (idx.owner < 0 || idx.mark < 0) return null;
  const get = (r, i) => (i >= 0 && r[i] !== undefined ? clean(r[i]) : '');
  return rows.slice(1).map((r) => ({
    name: get(r, idx.owner),
    address: get(r, idx.address),
    registration_mark: get(r, idx.mark),
    manufacturer: get(r, idx.manufacturer),
    model: get(r, idx.model),
    serial_no: get(r, idx.serial),
    registered_on: get(r, idx.registered),
  }));
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (typeof keyword !== 'string' || !keyword.trim()) {
      return fail('other', SOURCES[0].url, 'no company name given');
    }
    const want = nameKey(keyword);
    if (!want) {
      return fail('other', SOURCES[0].url, 'company name has no letters or digits once the legal form is removed');
    }

    const fetched = await Promise.all(SOURCES.map((s) => getText(s.url).then((r) => ({ s, r }))));

    const records = [];
    const matchedUrls = [];
    const failures = [];
    for (const { s, r } of fetched) {
      if (!r.ok) {
        failures.push({ reason: r.reason, url: s.url, excerpt: `${s.source}: ${r.excerpt}` });
        continue;
      }
      if (s.kind === 'cert') {
        const rows = parseCerts(r.text);
        if (!rows) {
          failures.push({ reason: 'layout_changed', url: s.url, excerpt: `${s.source}: rows not in the expected format` });
          continue;
        }
        const hits = rows
          .filter((x) => nameKey(x.name) === want)
          .map((x) => ({ name: x.name, source: s.source, certificate_type: x.certificate_type, address: x.address, city_or_town: x.city_or_town, country: x.country }));
        if (hits.length) { records.push(...hits); matchedUrls.push(s.url); }
      } else {
        const rows = parseRegister(r.text);
        if (!rows) {
          failures.push({ reason: 'layout_changed', url: s.url, excerpt: `${s.source}: expected columns missing` });
          continue;
        }
        const hits = rows
          .filter((x) => nameKey(x.name) === want)
          .map((x) => ({ name: x.name, source: s.source, address: x.address, registration_mark: x.registration_mark, manufacturer: x.manufacturer, model: x.model, serial_no: x.serial_no, registered_on: x.registered_on }));
        if (hits.length) { records.push(...hits); matchedUrls.push(s.url); }
      }
    }

    if (records.length) {
      const sources = [...new Set(records.map((x) => x.source))];
      const unread = failures.length ? ` (${failures.length} source(s) not read: ${failures.map((f) => f.reason).join(', ')})` : '';
      const summary = records.slice(0, 3).map((x) => `${x.name} | ${x.source}`).join('; ');
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchedUrls[0],
        excerpt: `${records.length} record(s) in ${sources.join('; ')}${unread}. ${summary}`.slice(0, 500),
      };
    }

    if (failures.length) {
      failures.sort((a, b) => FAILURE_ORDER.indexOf(a.reason) - FAILURE_ORDER.indexOf(b.reason));
      const f = failures[0];
      return fail(f.reason, f.url, f.excerpt.slice(0, 500));
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SOURCES[0].url,
      excerpt: `No exact name match in ${SOURCES.map((s) => s.source).join('; ')}`,
    };
  } catch (err) {
    return fail('other', SOURCES[0].url, String(err?.message || err).slice(0, 300));
  }
}
