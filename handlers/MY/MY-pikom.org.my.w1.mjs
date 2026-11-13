export const meta = {
  task: 'MY-pikom.org.my',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_no', 'address', 'tel', 'email', 'website', 'contact_person', 'designation',
    'total_employees', 'sales_turnover', 'industry_verticals_served', 'member_page'],
  canary: { found: '10 Infinity Sdn Bhd', not_found: 'Syarikat Tiada Wujud Sdn Bhd' },
};

// PIKOM member directory: the site search (?s=) finds member pages under /member/<slug>/,
// and each member page lists Company Name, Company Reg. No, Address, Tel, Email, Website, etc.
const BASE = 'https://pikom.org.my';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_SEARCH_PAGES = 4;
const MAX_DETAIL = 5;
const DEADLINE_MS = 45000;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', rarr: '->',
  ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

function safeChar(code, fallback) {
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Names compared without case, spaces, punctuation: "SDN. BHD." == "Sdn Bhd"; "(M)" is dropped. */
function normalizeName(s) {
  return decode(s).toLowerCase().replace(/\(\s*m\s*\)/g, ' ').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Search text: punctuation removed, because the site search returns nothing when "SDN." keeps its dot. */
function searchText(keyword) {
  return decode(keyword).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

async function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
}

function parseResults(html) {
  const out = [];
  const re = /<h3 class="thsn-post-title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = new URL(decode(m[1]), BASE).href;
    if (url.startsWith(`${BASE}/member/`) && !out.some((r) => r.url === url)) {
      out.push({ url, title: cleanText(m[2]) });
    }
  }
  return out;
}

function parseMember(html, url) {
  const fields = {};
  const map = {
    'company name': 'name', 'company reg. no': 'registration_no', 'address': 'address', 'tel': 'tel',
    'email': 'email', 'website': 'website', 'contact of business enquiry': 'contact_person',
    'designation': 'designation', 'total employees': 'total_employees', 'sales turnover': 'sales_turnover',
    'industry / verticals served': 'industry_verticals_served',
  };
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const key = map[cleanText(m[1]).toLowerCase()];
    if (key && !(key in fields)) fields[key] = cleanText(m[2]);
  }
  if (!fields.name) return null;
  return { ...fields, member_page: url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Node on Windows aborts (exit 127, "UV_HANDLE_CLOSING") when the runner calls process.exit() while a
  // fetch socket is still closing. A short pause lets the sockets close first; the answer is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function search(keyword) {
  const started = Date.now();
  let firstUrl = `${BASE}/?s=${encodeURIComponent(searchText(keyword))}`;
  try {
    const want = normalizeName(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
    }

    // Step 1: site search, following result pages until the exact name is found or the list ends.
    const matches = [];
    const seen = [];
    let url = firstUrl;
    let pages = 0;
    let listEnded = false;
    while (true) {
      const res = await get(url);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const noResults = /search-no-results|No Results Found/i.test(html);
      const results = parseResults(html);
      if (!noResults && results.length === 0 && !/thsn-search-results/.test(html)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }
      for (const r of results) {
        seen.push(r.title);
        if (normalizeName(r.title) === want && !matches.some((x) => x.url === r.url)) matches.push(r);
      }
      pages++;
      const hasNext = /class="next page-numbers"/.test(html);
      if (!hasNext) { listEnded = true; break; }
      if (matches.length > 0) break;
      if (pages >= MAX_SEARCH_PAGES || Date.now() - started > DEADLINE_MS) break;
      url = `${BASE}/page/${pages + 1}/?s=${encodeURIComponent(searchText(keyword))}`;
    }

    if (matches.length === 0) {
      if (!listEnded) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
          excerpt: `search returned more than ${pages} pages; the exact name was not reached` };
      }
      const near = [...new Set(seen)].slice(0, 5).join('; ');
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: near ? `No member with this exact name. Similar results: ${near}` : 'No Results Found on pikom.org.my' };
    }

    // Step 2: read each matching member page for the registration number and contact fields.
    const records = [];
    for (const m of matches.slice(0, MAX_DETAIL)) {
      const res = await get(m.url);
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: m.url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      if (!/woocommerce-product-attributes/.test(html)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: m.url, excerpt: cleanText(html).slice(0, 300) };
      }
      const rec = parseMember(html, m.url);
      if (rec && normalizeName(rec.name) === want) records.push(rec);
    }

    if (records.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: matches[0].url,
        excerpt: 'member page did not show the company name in the expected table' };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].member_page,
      excerpt: `${records[0].name}; Reg. No ${records[0].registration_no || 'n/a'}`,
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: firstUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
