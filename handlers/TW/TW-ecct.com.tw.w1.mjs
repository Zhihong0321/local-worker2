export const meta = {
  task: 'TW-ecct.com.tw',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_zh', 'comp_id', 'headquarter_address', 'address_zh', 'regional', 'telephone', 'business_type', 'nationality', 'website'],
  canary: { found: 'ABB Ltd.', not_found: '甲乙丙丁測試股份有限公司' },
};

// ECCT has no name search. Its membership directory lists every member by the first letter of the English name:
//   /membership-directory/?prefix=A ... Z, 0   (each page = all members starting with that letter, EN + CN names)
// Each member has a detail page /membership?compId=N. A Latin name is looked up on its own letter page; a name with
// Chinese characters (or a name that does not start with a letter) is looked up on all 27 letter pages.

const BASE = 'https://www.ecct.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '0'];
const LEGAL_EN = new Set(['ltd', 'limited', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'llc', 'gmbh', 'plc', 'ag',
  'bv', 'sa', 'nv', 'pte', 'sdn', 'bhd', 'company', 'lp', 'llp', 'srl', 'spa', 'ab', 'oy', 'kk', 'pty']);
const CJK = /[㐀-鿿豈-﫿]/;
const TOTAL_BUDGET_MS = 55000; // the whole call must finish in under 60 s
const PER_FETCH_MS = 25000;
const PAGE_CONCURRENCY = 6;

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Name as a comparable key: NFKC, lower case, punctuation removed, trailing legal form removed (Ltd, Inc, GmbH ...).
function normEn(s) {
  const tokens = clean(s).normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9㐀-鿿]+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length && LEGAL_EN.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

// Chinese name as a comparable key: spaces and punctuation removed, 股份有限公司 / 有限公司 removed.
function normZh(s) {
  return clean(s).normalize('NFKC').replace(/[\s.,。·()\-]/g, '').replace(/股份有限公司|有限公司/g, '').toLowerCase();
}

// Exact match of the normalised name only: a similar word is not a match.
function isSameCompany(keyword, entry) {
  const kEn = normEn(keyword);
  const eEn = normEn(entry.name);
  if (kEn && eEn && kEn === eEn) return true;
  const kZh = normZh(keyword);
  const eZh = normZh(entry.name_zh);
  return Boolean(kZh && eZh && kZh === eZh);
}

function parseListing(html) {
  const out = new Map();
  const re = /<div class="compNameEn"><a href="([^"]*)">([\s\S]*?)<\/a><\/div>(?:\s*<div class="compNameCh">([\s\S]*?)<\/div>)?/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const detailUrl = decode(m[1]);
    const id = (detailUrl.match(/compId=(\d+)/) || [])[1] || '';
    const name = clean(m[2]);
    if (!name) continue;
    const key = id || name;
    if (!out.has(key)) out.set(key, { comp_id: id, detail_url: detailUrl, name, name_zh: clean(m[3] || '') });
  }
  return [...out.values()];
}

// Never throws: returns { ok: true, html } or { ok: false, reason, excerpt }.
async function getPage(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,zh-TW;q=0.8',
        'Connection': 'close',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    if (/cf-chl|Just a moment|captcha/i.test(html.slice(0, 20000))) return { ok: false, reason: 'blocked', excerpt: 'bot check page' };
    return { ok: true, html };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
}

async function runPool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function readDetail(m, endAt) {
  const rec = {
    name: m.name, name_zh: m.name_zh, comp_id: m.comp_id,
    headquarter_address: '', address_zh: '', regional: '', telephone: '', business_type: '', nationality: '', website: '',
  };
  const remaining = endAt - Date.now();
  if (remaining < 1000) { rec.detail_note = 'detail page not read: time budget used up'; return rec; }
  const page = await getPage(m.detail_url, Math.min(PER_FETCH_MS, remaining));
  if (!page.ok) { rec.detail_note = `detail page not read: ${page.reason} (${page.excerpt})`; return rec; }
  const table = (page.html.match(/<table class="compInfo-table"[\s\S]*?<\/table>/) || [''])[0];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const text = clean(tr);
    const i = text.indexOf('：');
    if (i > 0) {
      const label = text.slice(0, i).trim().toLowerCase();
      const value = text.slice(i + 1).trim();
      if (label.startsWith('headquarter address')) rec.headquarter_address = value;
      else if (label === 'regional') rec.regional = value;
      else if (label === 'telephone') rec.telephone = value;
      else if (label === 'business type') rec.business_type = value;
      else if (label === 'company nationality') rec.nationality = value;
      else if (label === 'website') rec.website = value;
    } else if (!rec.address_zh && CJK.test(text)) {
      rec.address_zh = text; // the Chinese address row has no label
    }
  }
  return rec;
}

const PRIORITY = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

// Let the sockets finish closing before the caller exits: on Windows, exiting straight after the last fetch can abort
// Node (libuv assertion, exit 127) even though the answer was already printed.
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  await settle();
  return answer;
}

async function run(keyword) {
  const endAt = Date.now() + TOTAL_BUDGET_MS;
  try {
    const kw = clean(keyword).normalize('NFKC');
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty keyword' };

    const scanAll = CJK.test(kw) || !/^[A-Za-z]/.test(kw);
    const letters = scanAll ? LETTERS : [kw[0].toUpperCase()];

    const pages = await runPool(letters, PAGE_CONCURRENCY, async (letter) => {
      const url = `${BASE}/membership-directory/?prefix=${encodeURIComponent(letter)}`;
      const remaining = endAt - Date.now();
      if (remaining < 1000) return { letter, url, ok: false, reason: 'timeout', excerpt: 'time budget used up before this page' };
      const page = await getPage(url, Math.min(PER_FETCH_MS, remaining));
      if (!page.ok) return { letter, url, ok: false, reason: page.reason, excerpt: page.excerpt };
      // A letter with no members shows the site's own "not found" text; anything else must show the member list.
      if (!/compNameEn|cat-not-found/.test(page.html)) {
        return { letter, url, ok: false, reason: 'layout_changed', excerpt: clean(page.html).slice(0, 300) };
      }
      return { letter, url, ok: true, entries: parseListing(page.html) };
    });

    const matches = [];
    const seen = new Set();
    let totalMembers = 0;
    for (const p of pages) {
      if (!p.ok) continue;
      totalMembers += p.entries.length;
      for (const e of p.entries) {
        const key = e.comp_id || e.name;
        if (!seen.has(key) && isSameCompany(kw, e)) { seen.add(key); matches.push(e); }
      }
    }

    if (matches.length) {
      const records = [];
      for (const m of matches) records.push(await readDetail(m, endAt));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matches[0].detail_url,
        excerpt: matches.map((m) => `${m.name} / ${m.name_zh}`).join(' | ').slice(0, 500),
      };
    }

    const failed = pages.filter((p) => !p.ok);
    if (failed.length) {
      // Some letter pages could not be read, so the company may be on one of them: never report not_found.
      failed.sort((a, b) => PRIORITY.indexOf(a.reason) - PRIORITY.indexOf(b.reason));
      const f = failed[0];
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: f.url,
        excerpt: `${failed.length} of ${pages.length} directory pages not read; first: ${f.letter} ${f.excerpt}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: scanAll ? `${BASE}/membership-directory/` : pages[0].url,
      excerpt: `No member named "${kw}" in the ECCT membership directory (letter pages ${letters.join(', ')}; ${totalMembers} member entries checked)`,
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
