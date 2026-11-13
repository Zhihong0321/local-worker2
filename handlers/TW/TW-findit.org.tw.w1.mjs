export const meta = {
  task: 'TW-findit.org.tw', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'startup_id', 'registration_no', 'status', 'representative', 'founded_year', 'capital_ntd', 'address', 'main_category', 'detail_url'],
  canary: { found: '習慣健康國際股份有限公司', not_found: '甲乙丙丁測試股份有限公司' },
};

// findit.org.tw now 301-redirects to findit.sme.gov.tw, and its certificate only covers the sme.gov.tw host,
// so the handler talks to findit.sme.gov.tw directly.
const BASE = 'https://findit.sme.gov.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25000;   // every fetch
const BUDGET_MS = 45000;    // stop starting new requests after this (the whole call must finish in 60 s)
const MAX_PAGES = 10;       // result pages read per search term

const SEARCH_URL = `${BASE}/tw/Startup/SearchApi`;
const LIST_URL = (term) => `${BASE}/tw/Startup?Keyword=${encodeURIComponent(term)}`;

/** Thrown inside the handler; turned into a couldnt_check answer. */
class Stop extends Error {
  constructor(reason, excerpt, source_url) { super(excerpt); this.reason = reason; this.source_url = source_url; }
}

// Name normalising: full/half width, case, 臺 = 台, punctuation, then the legal form at the end is dropped.
const CJK_FORM = /(股份有限公司|有限責任公司|有限公司|股份有限|有限責任|公司)$/;
const EN_FORM = /(^|\s)(co ltd|ltd|inc|corp|corporation|company|limited|co)$/;

function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/臺/g, '台').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Key used to compare names: normalised, legal form removed, spaces removed. */
function nameKey(name) {
  const full = normalize(name);
  let s = full;
  for (;;) {
    const before = s;
    s = s.replace(CJK_FORM, '').replace(EN_FORM, '').trim();
    if (s === before) break;
  }
  if (!s) s = full;
  return s.replace(/\s+/g, '');
}

/** The keyword as typed, with the legal form removed, used as the site search text. */
function searchTerm(keyword) {
  let s = String(keyword).normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (;;) {
    const before = s;
    s = s.replace(/(股份有限公司|有限責任公司|有限公司|股份有限|有限責任|公司)$/, '')
      .replace(/(^|\s)(co\.?,?\s*ltd\.?|ltd\.?|inc\.?|corp\.?|corporation|company|limited|co\.?)$/i, '')
      .replace(/[\s,.]+$/, '').trim();
    if (s === before) break;
  }
  return s || String(keyword).trim();
}

function clean(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** One search term: reads result pages until the last page, a cap, or the time budget. */
async function searchAll(term, start) {
  const items = [];
  for (let page = 1, pages = 0; ; page++) {
    if (Date.now() - start > BUDGET_MS) throw new Stop('timeout', 'ran out of time while reading search results', LIST_URL(term));
    const form = new FormData();
    form.append('Keyword', term);
    form.append('pageNumber', String(page));
    let res;
    try {
      res = await fetch(SEARCH_URL, {
        method: 'POST', body: form,
        headers: { 'user-agent': UA, 'accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const reason = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
      throw new Stop(reason, String(e && e.message || e).slice(0, 200), LIST_URL(term));
    }
    if (res.status === 403 || res.status === 429) throw new Stop('blocked', `HTTP ${res.status}`, LIST_URL(term));
    if (!res.ok) throw new Stop('http_error', `HTTP ${res.status}`, LIST_URL(term));

    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch (e) {
      if (/captcha|驗證碼|access denied|請登入/i.test(text)) throw new Stop('blocked', 'the search answered with a bot or login page', LIST_URL(term));
      throw new Stop('layout_changed', text.slice(0, 300), LIST_URL(term));
    }
    if (!j || typeof j !== 'object' || (j.Items !== null && !Array.isArray(j.Items)) || typeof j.PageCount !== 'number') {
      throw new Stop('layout_changed', text.slice(0, 300), LIST_URL(term));
    }
    const list = Array.isArray(j.Items) ? j.Items : [];
    items.push(...list);
    pages++;
    if (page >= j.PageCount || list.length === 0) return { items, truncated: false };
    if (pages >= MAX_PAGES) return { items, truncated: true };
  }
}

/** Reads the public company page: registration no., status, representative, year, capital, address. */
async function readDetail(url, start) {
  if (Date.now() - start > 50000) return { error: 'skipped: time budget' };
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const txt = clean(await res.text());
    const grab = (label, re) => { const m = txt.match(new RegExp(label + '\\s*' + re)); return m ? m[1].trim() : ''; };
    const i = txt.indexOf('統一編號');
    return {
      registration_no: grab('統一編號', '(\\d{8})'),
      status: grab('公司狀態', '([^\\s]{2,8})'),
      representative: grab('負責人', '([^\\s]{1,30})'),
      founded_year: grab('成立年份', '(\\d{4})'),
      capital_ntd: grab('實收資本額', '([\\d,]+)'),
      address: grab('註冊地址', '(.{1,200}?)\\s*(?:網站連結|另開新視窗|$)'),
      excerpt: i >= 0 ? txt.slice(Math.max(0, i - 80), i + 260) : txt.slice(0, 300),
      error: '',
    };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 200) };
  }
}

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const start = Date.now();
  const input = String(keyword || '').trim();
  if (!input) return answer('couldnt_check', 'other', [], `${BASE}/tw/Startup`, 'empty company name');
  try {
    const key = nameKey(input);
    const base = searchTerm(input);
    // The site matches the typed text as a substring and may write 台 or 臺 differently: search both spellings.
    const terms = [...new Set([base, base.replace(/臺/g, '台'), base.replace(/台/g, '臺')])];

    const hits = new Map();
    let truncated = false;
    for (const term of terms) {
      const r = await searchAll(term, start);
      truncated = truncated || r.truncated;
      for (const it of r.items) if (!hits.has(it.StartupID)) hits.set(it.StartupID, it);
    }
    const all = [...hits.values()];
    const matches = all.filter((it) => nameKey(it.CompanyName) === key);

    if (matches.length === 0) {
      if (truncated) {
        return answer('couldnt_check', 'other', [], LIST_URL(base),
          `more than ${MAX_PAGES} result pages for "${base}"; the exact name was not in the pages read`);
      }
      const similar = all.slice(0, 3).map((it) => it.CompanyName).join('; ');
      return answer('not_found', '', [], LIST_URL(base),
        `0 companies with this name (${all.length} search hits${similar ? ', for example: ' + similar : ''})`);
    }

    const records = [];
    let excerpt = '';
    for (const it of matches) {
      const url = new URL(it.URL, BASE).href;
      const d = await readDetail(url, start);
      if (!excerpt && d.excerpt) excerpt = d.excerpt;
      records.push({
        name: it.CompanyName,
        startup_id: it.StartupID,
        registration_no: d.registration_no || '',
        status: d.status || '',
        representative: d.representative || '',
        founded_year: d.founded_year || String(it.FoundedYear || ''),
        capital_ntd: d.capital_ntd || '',
        address: d.address || it.Location || '',
        main_category: it.MainCatName || '',
        detail_url: url,
        detail_error: d.error || '',
      });
    }
    return answer('found', '', records, records[0].detail_url, excerpt || matches[0].CompanyName);
  } catch (e) {
    if (e instanceof Stop) return answer('couldnt_check', e.reason, [], e.source_url, e.message);
    return answer('couldnt_check', 'other', [], LIST_URL(input), String(e && e.message || e).slice(0, 300));
  }
}
