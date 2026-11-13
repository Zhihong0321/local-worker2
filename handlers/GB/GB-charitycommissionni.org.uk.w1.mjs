export const meta = { task: 'GB-charitycommissionni.org.uk', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'charity_no', 'company_no', 'status', 'org_type', 'date_registered', 'address', 'website'],
  canary: { found: 'Age NI', not_found: 'Zqxvbnm Qwrtp Limited' } };

const BASE = 'https://www.charitycommissionni.org.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['limited', 'ltd', 'plc', 'company', 'co', 'cio', 'cic', 'incorporated', 'inc', 'llp', 'lp']);
const MAX_PAGES = 8;      // search pages read per lookup (15 results each)
const MAX_DETAILS = 5;    // detail pages read per lookup
const BUDGET_MS = 55000;  // the whole call must finish in under 60 s

class Failure extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

/** Lower-case words of a name, punctuation removed. */
function words(str) {
  return String(str || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Words of a name without a trailing legal form ("AGE NI LIMITED" -> age ni). */
function coreWords(str) {
  const w = words(str);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

function normName(str) {
  return coreWords(str).join('');
}

function cleanText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&#x27;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

/** One GET. Throws Failure with a reason; a bot wall is blocked, anything else unexpected is layout_changed. */
async function getBody(url, accept, deadline, looksRight) {
  if (Date.now() >= deadline) throw new Failure('timeout', 'the 60 s budget ran out before ' + url);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) throw new Failure('blocked', `HTTP ${res.status} from ${url}`);
  if (!res.ok) throw new Failure('http_error', `HTTP ${res.status} from ${url}`);
  const body = await res.text();
  if (!looksRight(body)) {
    if (/captcha|cf-chl|challenge-platform|access denied|are you a robot/i.test(body)) {
      throw new Failure('blocked', 'bot check page from ' + url);
    }
    throw new Failure('layout_changed', 'unexpected page from ' + url);
  }
  return body;
}

async function searchPage(query, page, deadline) {
  const url = `${BASE}/api/charity-search/results?searchText=${encodeURIComponent(query)}&pageNumber=${page}`;
  const body = await getBody(url, 'application/json', deadline, (b) => {
    try { const d = JSON.parse(b); return Array.isArray(d?.results?.pageItems); } catch { return false; }
  });
  return JSON.parse(body).results;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + BUDGET_MS;
  const name = String(keyword || '').trim();
  const searchUrl = `${BASE}/charity-search/?searchText=${encodeURIComponent(name)}`;
  try {
    if (!coreWords(name).length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
    }

    // Search with the name minus its legal form, then keep only exact matches on the normalised name.
    const query = coreWords(name).join(' ');
    const want = normName(name);
    const matches = [];
    let total = 0;
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const results = await searchPage(query, page, deadline);
      total = results.totalItems ?? 0;
      pages = results.totalPages ?? 0;
      for (const row of results.pageItems) {
        if (normName(row.name) === want) matches.push(row);
      }
      if (page >= pages) break;
    }

    if (!matches.length) {
      if (pages > MAX_PAGES) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `${total} similar results, more than ${MAX_PAGES} pages; exact match not reached` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 exact matches for "${name}" (${total} similar results)` };
    }

    // Read each matching charity's detail page for charity/company number, dates, address.
    const records = [];
    for (const row of matches.slice(0, MAX_DETAILS)) {
      const detailUrl = new URL(row.url, BASE).href;
      const body = await getBody(detailUrl, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', deadline,
        (b) => /Charity no\./i.test(cleanText(b)));
      const text = cleanText(body);
      records.push({
        name: row.name,
        charity_no: row.regNo,
        company_no: pick(text, /Company no\.?\s*(\d[\dA-Za-z-]*)/i),
        status: row.statusLabel || '',
        org_type: row.orgType || '',
        date_registered: pick(text, /Date registered\.?\s*(\d{2}\/\d{2}\/\d{4})/i),
        address: pick(text, /Public Address\s*(.*?)\s*List of regions/i),
        website: pick(text, /Website:\s*((?:https?:\/\/|www\.)\S+)/i),
        source_url: detailUrl,
      });
    }

    const r0 = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: r0.source_url,
      excerpt: `${r0.name}: charity no. ${r0.charity_no}, company no. ${r0.company_no || 'none'}, ${r0.status}, registered ${r0.date_registered || 'unknown'}`,
    };
  } catch (err) {
    if (err instanceof Failure) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: searchUrl, excerpt: err.message.slice(0, 300) };
    }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
