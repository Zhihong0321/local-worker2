export const meta = {
  task: 'PH-edge.pse.com.ph',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'symbol', 'sector', 'subsector', 'corporate_life', 'incorporation_date',
    'number_of_directors', 'stockholders_meeting', 'fiscal_year', 'external_auditor', 'transfer_agent',
    'business_address', 'telephone', 'fax', 'website', 'description', 'detail_url'],
  canary: { found: 'Ayala Land, Inc.', not_found: 'Kompanyang Hindi Nakalista Inc' },
};

const BASE = 'https://edge.pse.com.ph';
const SEARCH_URL = `${BASE}/cm/companySearch.ax`;
const FORM_URL = `${BASE}/companyDirectory/form.do`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10;          // the site shows 10 companies per page
const TOTAL_BUDGET_MS = 45000; // the whole call must finish in under 60 s
const REQ_TIMEOUT_MS = 25000;
const MAX_EXACT = 5;
// Legal-form words and filler words that are ignored when comparing names.
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
  'the', 'and', 'sdn', 'bhd', 'plc']);

let DEADLINE = 0;

class Fail extends Error {
  constructor(reason, excerpt, url) {
    super(excerpt);
    this.reason = reason;
    this.url = url;
  }
}

function couldnt(reason, excerpt, url) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

/** Undo HTML entities; the site double-encodes some ("&amp;amp;"), so repeat until stable. */
function decode(s) {
  let out = String(s || '');
  for (let i = 0; i < 3 && /&(amp|nbsp|quot|lt|gt|#0?39);/i.test(out); i++) {
    out = out.replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#0?39;/g, "'");
  }
  return out;
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: lower case, punctuation and legal-form words removed. */
function nameKey(s) {
  return tokens(s).filter((t) => !LEGAL.has(t)).join('');
}

function tokens(s) {
  return decode(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

function remaining() {
  const left = DEADLINE - Date.now();
  if (left <= 0) throw new Fail('timeout', 'stopped: the 45 s budget for this lookup ran out', FORM_URL);
  return Math.min(REQ_TIMEOUT_MS, left);
}

function checkResponse(res, html, url) {
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`, url);
  if (/captcha|cf-chl|challenge-platform|verify you are human|access denied/i.test(html)) {
    throw new Fail('blocked', 'bot check or access-denied page', url);
  }
}

async function postSearch(term, pNum) {
  const body = new URLSearchParams({ keyword: term });
  if (pNum > 1) body.set('pNum', String(pNum));
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    body,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': FORM_URL,
    },
    signal: AbortSignal.timeout(remaining()),
  });
  const html = await res.text();
  checkResponse(res, html, FORM_URL);
  return html;
}

/** Parses one page of /cm/companySearch.ax. Returns the rows and the page counts. */
function parseSearch(html) {
  const m = html.match(/\[(\d+)\/(\d+)\]\s*\[Total\s*(\d+)\]/);
  if (!m) {
    if (/no data\./i.test(html)) return { total: 0, pages: 0, rows: [] };
    throw new Fail('layout_changed', html.slice(0, 300), FORM_URL);
  }
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const sc = tr.match(/setCompany\(\{company_id:"(\d+)",company_nm:"([^"]*)"\}\)/);
    if (!sc) continue;
    const cells = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(clean);
    rows.push({ company_id: sc[1], name: clean(sc[2]), symbol: cells[1] || '' });
  }
  const total = Number(m[3]);
  if (total > 0 && rows.length === 0) throw new Fail('layout_changed', html.slice(0, 300), FORM_URL);
  return { total, pages: Number(m[2]), rows };
}

/** Runs one search term over all its pages (up to MAX_PAGES). */
async function searchTerm(term) {
  const rows = [];
  let total = 0;
  let pages = 1;
  for (let p = 1; p <= pages && p <= MAX_PAGES; p++) {
    const parsed = parseSearch(await postSearch(term, p));
    total = parsed.total;
    pages = parsed.pages;
    rows.push(...parsed.rows);
    if (total === 0) break;
  }
  return { rows, total, truncated: pages > MAX_PAGES };
}

function field(map, label) {
  return map[label] || '';
}

/** Reads one company's information page. */
async function getDetail(row) {
  const url = `${BASE}/companyInformation/form.do?cmpy_id=${row.company_id}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Referer': FORM_URL,
    },
    signal: AbortSignal.timeout(remaining()),
  });
  const html = await res.text();
  checkResponse(res, html, url);
  if (!/Security Information/.test(html) || !/class="compInfo"/.test(html)) {
    throw new Fail('layout_changed', clean(html).slice(0, 300), url);
  }

  const map = {};
  for (const m of html.matchAll(/<tr>\s*<th>([\s\S]*?)<\/th>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    map[clean(m[1])] = clean(m[2]).replace(/\(Month\/Day\)/, '').trim();
  }
  const nameMatch = html.match(/<div class="compInfo">\s*<p[^>]*>([\s\S]*?)<\/p>/);
  const descMatch = html.match(/<caption>Company Description<\/caption>[\s\S]*?<td>([\s\S]*?)<\/td>/);

  return {
    name: nameMatch ? clean(nameMatch[1]) : row.name,
    company_id: row.company_id,
    symbol: row.symbol,
    sector: field(map, 'Sector'),
    subsector: field(map, 'Subsector'),
    corporate_life: field(map, 'Corporate Life'),
    incorporation_date: field(map, 'Incorporation Date'),
    number_of_directors: field(map, 'Number of Directors'),
    stockholders_meeting: field(map, "Stockholders' Meeting as per By-Laws"),
    fiscal_year: field(map, 'Fiscal Year'),
    external_auditor: field(map, 'External Auditor'),
    transfer_agent: field(map, 'Transfer Agent'),
    business_address: field(map, 'Business Address'),
    telephone: field(map, 'Telephone Number'),
    fax: field(map, 'Fax Number'),
    website: field(map, 'Website'),
    description: descMatch ? clean(descMatch[1]) : '',
    detail_url: url,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  DEADLINE = Date.now() + TOTAL_BUDGET_MS;
  try {
    const input = String(keyword || '').trim();
    const want = nameKey(input);
    if (!want) return couldnt('other', 'the company name has no letters to search for', FORM_URL);

    // Search as typed first; then without punctuation and legal-form words; then by the longest
    // word, and for a compact name ("ABSCBN") by the first 3 letters, because the site writes
    // "Sta. Lucia" and "ABS-CBN" with punctuation we cannot predict. Each hit is still compared by key.
    const core = tokens(input).filter((t) => !LEGAL.has(t));
    const longest = core.reduce((a, b) => (b.length > a.length ? b : a), '');
    const prefix = core[0] && core[0].length > 3 ? core[0].slice(0, 3) : '';
    const candidates = [input, core.join(' '), longest, prefix];
    const terms = [];
    for (const c of candidates) {
      if (c && !terms.some((t) => t.toLowerCase() === c.toLowerCase())) terms.push(c);
    }

    let exact = [];
    let unchecked = false;
    for (const term of terms) {
      const r = await searchTerm(term);
      exact = [];
      const seen = new Set();
      for (const row of r.rows) {
        if (nameKey(row.name) === want && !seen.has(row.company_id)) {
          seen.add(row.company_id);
          exact.push(row);
        }
      }
      if (exact.length) break;
      if (r.truncated) unchecked = true;
    }

    if (!exact.length) {
      if (unchecked) {
        return couldnt('other', `the search results were too many to check all of them (searched: ${terms.join(' | ')})`, FORM_URL);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: FORM_URL,
        excerpt: `PSE EDGE company search returned no company named "${input}" (searched: ${terms.join(' | ')})`,
      };
    }

    const records = [];
    for (const row of exact.slice(0, MAX_EXACT)) {
      records.push(await getDetail(row));
    }
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.detail_url,
      excerpt: `${first.name}${first.symbol ? ' (' + first.symbol + ')' : ''}; ${first.sector}. ${first.description}`.slice(0, 300),
    };
  } catch (err) {
    if (err instanceof Fail) return couldnt(err.reason, err.message, err.url);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return couldnt('timeout', 'the site did not answer in time', FORM_URL);
    }
    return couldnt('other', String((err && err.message) || err), FORM_URL);
  }
}
