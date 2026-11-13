export const meta = {
  task: 'IE-sfpa.ie',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'approval_number', 'address', 'county', 'categories', 'activity_codes', 'certificate_number', 'list'],
  canary: { found: 'The Burren Smokehouse Ltd', not_found: 'Cuideachta Iascaigh Ghlas na Mara Teoranta' },
};

// SFPA publishes three approval tables on one section of the site, each complete in the HTML (no paging).
const BASE = 'https://www.sfpa.ie/What-We-Do/Seafood-Safety/Registration-Approval-of-Businesses/List-of-Approved-Establishments';
const LISTS = [
  { label: 'Approved Establishments', url: `${BASE}/Approved-Establishments` },
  { label: 'Approved Factory Vessels', url: `${BASE}/Approved-Factory-Vessels` },
  { label: 'Approved Freezer Vessels', url: `${BASE}/Approved-Freezer-Vessels` },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal forms (English and Irish) dropped from the END of a name only, so "X Teoranta" and "X" compare equal.
const LEGAL = new Set(['ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'unlimited', 'uc']);

function decode(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => (Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ''));
}

function cleanText(html) {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Case, accents, punctuation and "&" are ignored; only the words are compared.
function fold(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameKey(s) {
  const tokens = fold(s).split(' ').filter(Boolean);
  while (tokens.length && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

// A listed name can be "Legal name T/A Trading name", "A/ B" or "X (Town)". Each part is a candidate, but
// the whole name must equal the typed company after normalising, so "Sligo Bay" never matches "Sligo Bay Oysters".
function candidates(name) {
  const noParen = name.replace(/\([^)]*\)/g, ' ');
  const parts = noParen.split(/\s+t\/a\s+|\s+trading as\s+|\//i);
  const set = new Set([nameKey(name), nameKey(noParen)]);
  for (const p of parts) set.add(nameKey(p));
  set.delete('');
  return set;
}

function parseRows(html) {
  const rows = [];
  for (const tb of html.match(/<tbody[\s\S]*?<\/tbody>/gi) || []) {
    for (const tr of tb.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
      if (cells.length >= 2) rows.push(cells);
    }
  }
  return rows;
}

async function getPage(list) {
  const fail = (reason, excerpt, url = list.url) => ({ ok: false, reason, excerpt, url, list });
  try {
    const res = await fetch(list.url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IE,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
    if (new URL(res.url).pathname.toLowerCase().startsWith('/login')) return fail('blocked', 'redirected to login');
    const html = await res.text();
    if (/captcha|cf-chl|just a moment\.\.\./i.test(html)) return fail('blocked', 'bot or captcha page');
    const rows = parseRows(html);
    if (!/<th[^>]*>\s*Approval Number\s*<\/th>/i.test(html) || rows.length === 0) {
      return fail('layout_changed', html.slice(0, 200));
    }
    return { ok: true, list, url: list.url, rows };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return fail('timeout', '25 s limit');
    return fail('other', String(err?.message || err).slice(0, 200));
  }
}

function toRecord(cells, list) {
  return {
    name: cells[1],
    approval_number: cells[0].replace(/\s*and\/\s*or\s*/i, ' / '),
    address: cells[2] || '',
    county: cells[3] || '',
    categories: cells[4] || '',
    activity_codes: cells[5] || '',
    certificate_number: cells[6] || '',
    list: list.label,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = nameKey(String(keyword ?? ''));
    if (key.length < 2) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'name too short to match' };
    }

    const pages = await Promise.all(LISTS.map(getPage));

    const matches = [];
    const failed = [];
    const counts = [];
    for (const p of pages) {
      if (!p.ok) { failed.push(p); continue; }
      counts.push(`${p.rows.length} ${p.list.label}`);
      for (const cells of p.rows) {
        if (candidates(cells[1]).has(key)) matches.push({ rec: toRecord(cells, p.list), url: p.url });
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(m => m.rec),
        source_url: matches[0].url,
        excerpt: matches.map(({ rec }) => [rec.approval_number, rec.name, rec.address, rec.county, rec.categories].join(' | ')).join(' ; ').slice(0, 500),
      };
    }

    // A list that could not be read might hold the company, so the answer is "couldn't check", never "not found".
    if (failed.length) {
      const f = failed[0];
      return { status: 'couldnt_check', reason: f.reason, records: [], source_url: f.url, excerpt: `${f.list.label}: ${f.excerpt}`.slice(0, 500) };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: BASE,
      excerpt: `No approval matches "${String(keyword).slice(0, 120)}" in ${counts.join(', ')}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
