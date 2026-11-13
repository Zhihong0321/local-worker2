export const meta = {
  task: 'TW-cens.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'supplier_id', 'chinese_name', 'url'],
  canary: { found: 'HIWIN TECHNOLOGIES CORP.', not_found: '宇宙無敵測試股份有限公司' },
};

const BASE = 'https://www.cens.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 4;          // search result pages to read (about 30 companies each)
const MAX_ZH_FETCH = 12;      // supplier pages to read when the keyword is in Chinese
const START_LIMIT_MS = 30000; // no new fetch starts after 30 s, so the whole call stays under 60 s

const EN_LEGAL = ['co', 'ltd', 'limited', 'corp', 'corporation', 'inc', 'incorporated', 'llc', 'plc', 'gmbh', 'sdn', 'bhd', 'pte'];
const EN_LEGAL_SET = new Set(EN_LEGAL);
const ZH_LEGAL = ['股份有限公司', '有限责任公司', '有限責任公司', '有限公司', '公司'];

// one company entry on a search result page: supplier id + name as the site writes it
const ENTRY_RE = /supplier_home_(\d+)\.html"><p class="title company-name">([\s\S]*?)<\/p>/g;
const COUNT_RE = /([\d,]+)\s+compan(?:y|ies)\s+(?:was|were)\s+found/i;

function hasCJK(s) { return /[㐀-鿿豈-﫿]/.test(s); }

function cleanText(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** English name, normalised: case, punctuation and legal form removed. */
function normEn(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u).filter((t) => t && !EN_LEGAL_SET.has(t)).join('');
}

/** Chinese name, normalised: spaces, punctuation and legal form removed. */
function normZh(s) {
  let t = String(s || '');
  for (const w of ZH_LEGAL) t = t.split(w).join('');
  return t.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The search query: the name without its legal form (the search is substring-based). */
function searchQuery(input) {
  let q = input;
  for (const w of ZH_LEGAL) q = q.split(w).join(' ');
  q = q.replace(new RegExp(`\\b(${EN_LEGAL.join('|')})\\b\\.?`, 'gi'), ' ');
  q = q.replace(/[,.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (q || input).slice(0, 50);
}

async function fetchText(url, started) {
  if (Date.now() - started > START_LIMIT_MS) return { fail: true, reason: 'timeout', excerpt: 'time budget used up before this request' };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8,zh-TW;q=0.6',
      },
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.text();
    return { fail: false, status: res.status, body };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: true, reason: timedOut ? 'timeout' : 'other', excerpt: String(e && e.message || e).slice(0, 300) };
  }
}

/** One search result page. Returns { total, entries, url } or { fail: {...} }. */
async function searchPage(q, page, started) {
  const url = `${BASE}/censv1/en/search_list.jsp?QRY=${encodeURIComponent(q)}&TYPE=sup&PAGE=${page}&fH=inner&SHOW=1`;
  const r = await fetchText(url, started);
  const fail = (reason, excerpt) => ({ fail: { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) } });
  if (r.fail) return fail(r.reason, r.excerpt);
  const html = r.body;
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  if (r.status === 403 || r.status === 429) return fail('blocked', `HTTP ${r.status}`);
  if (r.status !== 200) return fail('http_error', `HTTP ${r.status}`);
  const text = cleanText(html);
  const entries = [];
  for (const m of html.matchAll(ENTRY_RE)) entries.push({ id: m[1], name: cleanText(m[2]) });
  const count = html.match(COUNT_RE);
  if (count) {
    const total = Number(count[1].replace(/,/g, ''));
    if (total > 0 && entries.length === 0) return fail('layout_changed', text);
    return { total, entries, url };
  }
  if (/Results not Found|no Company matching result was found/i.test(text)) return { total: 0, entries: [], url };
  if (/just a moment|attention required|access denied|captcha/i.test(title)) return fail('blocked', title);
  return fail('layout_changed', text);
}

/** Chinese name of one supplier, from its zh page title. */
async function zhName(id, started) {
  const url = `${BASE}/cens/html/zh/supplier/supplier_home_${id}.html`;
  const r = await fetchText(url, started);
  if (r.fail) return { fail: { status: 'couldnt_check', reason: r.reason, records: [], source_url: url, excerpt: r.excerpt } };
  if (r.status === 403 || r.status === 429) return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${r.status}` } };
  if (r.status !== 200) return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${r.status}` } };
  const title = (r.body.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const name = title.split('|')[0].trim();
  if (!name) return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'no title on zh supplier page' } };
  return { name };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let result;
  try {
    result = await runLookup(keyword);
  } catch (e) {
    result = { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'handler error: ' + String(e && e.message || e).slice(0, 250) };
  }
  // Let the sockets used by the fetches close before the runner exits: on Windows, Node 24 aborts
  // (exit 127, after the answer is printed) when the process exits while a socket is still closing.
  await new Promise((r) => setTimeout(r, 300));
  return result;
}

async function runLookup(keyword) {
  const started = Date.now();
  try {
    const input = String(keyword || '').trim();
    if (!input) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };

    const q = searchQuery(input);
    const first = await searchPage(q, 1, started);
    if (first.fail) return first.fail;
    if (first.total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: first.url, excerpt: `0 companies found for "${q}"` };
    }

    // read the result pages (up to MAX_PAGES)
    const perPage = first.entries.length;
    const pagesNeeded = Math.ceil(first.total / perPage);
    const complete = pagesNeeded <= MAX_PAGES;
    let candidates = [...first.entries];
    let lastUrl = first.url;
    for (let p = 2; p <= Math.min(pagesNeeded, MAX_PAGES); p++) {
      const r = await searchPage(q, p, started);
      if (r.fail) return r.fail;
      candidates.push(...r.entries);
      lastUrl = r.url;
    }

    const records = [];
    if (!hasCJK(input)) {
      // English keyword: the list shows English names, compare them directly
      const want = normEn(input);
      for (const c of candidates) {
        if (normEn(c.name) === want) {
          records.push({ name: c.name, supplier_id: c.id, chinese_name: '', url: `${BASE}/cens/html/en/supplier/supplier_home_${c.id}.html` });
        }
      }
    } else {
      // Chinese keyword: the list shows English names, so read each supplier's Chinese name
      if (candidates.length > MAX_ZH_FETCH) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
          excerpt: `${first.total} companies match "${q}"; too many to read their Chinese names` };
      }
      const want = normZh(input);
      for (const c of candidates) {
        const z = await zhName(c.id, started);
        if (z.fail) return z.fail;
        if (normZh(z.name) === want) {
          records.push({ name: c.name, supplier_id: c.id, chinese_name: z.name, url: `${BASE}/cens/html/en/supplier/supplier_home_${c.id}.html` });
        }
      }
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: lastUrl,
        excerpt: `${records.length} match(es) for "${input}": ${records.map((r) => r.name).join(' | ')}`.slice(0, 300) };
    }
    if (!complete) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
        excerpt: `${first.total} companies match "${q}"; only the first ${MAX_PAGES} pages were read and none has this exact name` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: lastUrl,
      excerpt: `${first.total} companies match "${q}"; none has the same normalised name` };
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'handler error: ' + String(e && e.message || e).slice(0, 250) };
  }
}
