export const meta = {
  task: 'AU-consumer.vic.gov.au',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'register', 'licence_number', 'type', 'suburb', 'postcode', 'status', 'detail_url'],
  canary: { found: '14 Motors Pty Ltd', not_found: 'Zzqxwv Nonexistent Pty Ltd' },
};

// Consumer Affairs Victoria name searches on registers.consumer.vic.gov.au (four registers with the same results layout).
const BASE = 'https://registers.consumer.vic.gov.au';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};
const REGISTERS = [
  { key: 'estate_agents', label: 'Estate agents', path: '/EAsearch/PerformSearch',
    params: (n) => ({ NameOrLicenceNumber: 'Name', Name: n, SoundsLike: 'False', IncludeNonCurrentLicensees: 'False' }) },
  { key: 'conveyancers', label: 'Conveyancers', path: '/CvSearch/PerformSearch',
    params: (n) => ({ NameOrLicenceNumber: 'Name', Name: n, IncludeNonCurrentLicensees: 'False' }) },
  { key: 'motor_car_traders', label: 'Motor car traders', path: '/MctSearch/PerformSearch',
    params: (n) => ({ SearchBy: 'Name', Name: n, IncludeNonCurrentLicensees: 'False' }) },
  { key: 'co_operatives', label: 'Co-operatives', path: '/CnlSearch/PerformSearch',
    params: (n) => ({ SearchBy: 'Name', Name: n, IncludeNonCurrentLicensees: 'False' }) },
];
const MAX_PAGES = 10;
const TIME_LIMIT_MS = 40000;
const REASON_ORDER = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

function decode(s) {
  return (s || '').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}
function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function tokens(str) {
  return (str || '').toLowerCase().replace(/&/g, ' and ').replace(/-/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean);
}
const LEGAL = new Set(['pty', 'ltd', 'limited', 'proprietary', 'inc', 'incorporated', 'cooperative', 'operative']);
/** Normalised company name: case, punctuation and trailing legal form removed. */
function coreKey(str) {
  const t = tokens(str);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}
/** Search text: the name as typed, minus trailing legal form words (the registers match the business name). */
function searchText(name) {
  let s = name;
  let prev;
  const re = /[\s,]+(pty\.?|ltd\.?|limited|proprietary|inc\.?|incorporated|co-?operative|operative)$/i;
  do { prev = s; s = s.replace(re, ''); } while (s !== prev && s.length > 0);
  return s.trim() || name;
}
/** Rows of the results table(s). Column labels come from the cell's headerattr, else from the header row. */
function parseRows(html, reg, base) {
  const out = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    if (!/<td[\s>]/i.test(table)) continue;
    const ths = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cleanText(m[1]));
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = [];
      for (const m of tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)) {
        const attr = (m[1].match(/headerattr="([^"]*)"/i) || [])[1];
        cells.push({ label: attr || ths[cells.length] || '', html: m[2] });
      }
      if (!cells.length) continue;
      const nameCell = cells.find((c) => /^(name|licensee)$/i.test(c.label))
        || cells.find((c) => /<b>/i.test(c.html)) || cells[0];
      const bold = nameCell.html.match(/<b>([\s\S]*?)<\/b>/i);
      const name = bold ? cleanText(bold[1]) : cleanText(nameCell.html);
      if (!name) continue;
      const val = (re) => { const c = cells.find((x) => re.test(x.label)); return c ? cleanText(c.html) : ''; };
      const hrefs = [...tr.matchAll(/href="([^"]*)"/gi)].map((m) => decode(m[1]));
      const detail = hrefs.find((h) => /Details/i.test(h));
      out.push({
        name,
        register: reg.label,
        licence_number: val(/^licence/i),
        type: val(/^type$/i),
        suburb: val(/suburb/i),
        postcode: val(/postcode/i),
        status: val(/status/i),
        detail_url: detail ? new URL(detail, base).href : '',
      });
    }
  }
  return out;
}

/** One register: read every results page. Never throws. */
async function searchRegister(reg, term, start) {
  const res0 = { key: reg.key, label: reg.label, records: [], complete: false, reason: '', url: '', detail: '' };
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - start > TIME_LIMIT_MS) { res0.reason = 'timeout'; res0.detail = 'time limit reached'; return res0; }
      const params = new URLSearchParams({ ...reg.params(term), ...(page > 1 ? { PageNumber: String(page) } : {}) });
      const url = `${BASE}${reg.path}?${params.toString()}`;
      if (page === 1) res0.url = url;
      let res;
      try {
        res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        res0.reason = timedOut ? 'timeout' : 'other';
        res0.detail = String(e && e.message || e).slice(0, 120);
        return res0;
      }
      if (res.status === 403 || res.status === 429) { res0.reason = 'blocked'; res0.detail = `HTTP ${res.status}`; return res0; }
      if (!res.ok) { res0.reason = 'http_error'; res0.detail = `HTTP ${res.status}`; return res0; }
      const html = await res.text();
      if (/captcha|access denied|verify you are human/i.test(html) && !/headerattr=/i.test(html)) {
        res0.reason = 'blocked'; res0.detail = 'bot or captcha page'; return res0;
      }
      const noResults = /no\s+results\s+were\s+found/i.test(html);
      if (!noResults && !/<td[\s>]/i.test(html)) {
        res0.reason = 'layout_changed'; res0.detail = 'results table not found'; return res0;
      }
      res0.records.push(...parseRows(html, reg, BASE));
      if (!html.includes(`PageNumber=${page + 1}`)) { res0.complete = true; return res0; }
    }
    res0.reason = 'other';
    res0.detail = `more than ${MAX_PAGES} result pages; not all read`;
    return res0;
  } catch (e) {
    res0.reason = 'other';
    res0.detail = String(e && e.message || e).slice(0, 120);
    return res0;
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').replace(/\s+/g, ' ').trim();
  const home = `${BASE}/resources-and-tools/search-public-registers`;
  try {
    if (!name) return { status: 'couldnt_check', reason: 'other', records: [], source_url: home, excerpt: 'empty company name' };
    const term = searchText(name);
    const key = coreKey(name);
    const start = Date.now();
    const results = await Promise.all(REGISTERS.map((reg) => searchRegister(reg, term, start)));

    const matches = [];
    for (const r of results) for (const rec of r.records) if (coreKey(rec.name) === key) matches.push(rec);

    const summary = results.map((r) => `${r.label}: ${r.complete ? 'searched' : 'not read (' + r.reason + ')'}`).join('; ');

    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: first.detail_url || results.find((r) => r.records.includes(first)).url,
        excerpt: `${matches.length} match(es). ${summary}`.slice(0, 500),
      };
    }

    const failed = results.filter((r) => !r.complete);
    if (failed.length) {
      const reason = REASON_ORDER.find((x) => failed.some((r) => r.reason === x)) || 'other';
      const f = failed.find((r) => r.reason === reason);
      return {
        status: 'couldnt_check',
        reason,
        records: [],
        source_url: f.url || home,
        excerpt: `No match, but not every register could be read. ${summary} ${f.detail}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: results[0].url || home,
      excerpt: `No entries for "${term}" on the four registers. ${summary}`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: home, excerpt: String(err && err.message || err).slice(0, 300) };
  }
}
