export const meta = { task: 'TH-actai.co', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['company_id', 'name', 'province', 'total_projects', 'total_contract_money', 'total_budget_money', 'has_corruption_risk'],
  canary: { found: 'เอเซีย พลัส ไฮเทค คอร์ปอเรชั่น', not_found: 'ซีเอ็กซ์ซี ไม่มีจริง จำกัด' } };

// ACT Ai procurement tool (procurement.actai.co, linked from actai.co) reads its company list from this public JSON search.
const API = 'https://admin-procurement.actai.co/v2/company/search';
const PAGE_SIZE = 50;
const PAGES = 3; // the first 150 results for the search text, fetched in parallel
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words that do not change which company is meant (Thai and English), matched as whole words.
const LEGAL = new Set(['บริษัท', 'บจก', 'หจก', 'บมจ', 'ห้างหุ้นส่วนจำกัด', 'ห้างหุ้นส่วนสามัญ', 'จำกัด', 'มหาชน',
  'co', 'ltd', 'limited', 'plc', 'pcl']);

/** Split a name into lower-case words, with punctuation and brackets treated as spaces. */
function words(name) {
  return String(name || '').normalize('NFC').toLowerCase().replace(/[().,\-/&]/g, ' ').split(/\s+/).filter(Boolean);
}

/** The words of the company itself: legal form removed, so "บริษัท X จำกัด" and "X" are the same core. */
function coreWords(name) {
  return words(name)
    .map((w) => w.replace(/^บริษัท(?=.)/, '').replace(/(?<=.)จำกัด$/, ''))
    .filter((w) => w && !LEGAL.has(w));
}

/** Comparison key: core words joined with no spaces or punctuation. Two names match only if keys are equal. */
function nameKey(name) {
  return coreWords(name).join('').replace(/[^\p{L}\p{N}]/gu, '');
}

/** One search page. Never throws: returns { ok: true, data, url } or { ok: false, reason, excerpt, url }. */
async function fetchPage(text, page) {
  const url = `${API}?${new URLSearchParams({ keyword: text, page: String(page), pageSize: String(PAGE_SIZE) })}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });
    if ([401, 403, 429].includes(res.status)) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}`, url };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}`, url };
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch {
      const reason = /captcha|challenge|access denied|log ?in/i.test(body) ? 'blocked' : 'layout_changed';
      return { ok: false, reason, excerpt: body.slice(0, 300), url };
    }
    if (!data || !Array.isArray(data.searchResult)) return { ok: false, reason: 'layout_changed', excerpt: body.slice(0, 300), url };
    return { ok: true, data, url };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300), url };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const firstUrl = `${API}?${new URLSearchParams({ keyword: String(keyword || ''), page: '1', pageSize: String(PAGE_SIZE) })}`;
  try {
    const key = nameKey(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
        excerpt: 'the name has no company words to search for' };
    }
    const text = coreWords(keyword).join(' ');

    const pages = await Promise.all(Array.from({ length: PAGES }, (_, i) => fetchPage(text, i + 1)));

    const records = [];
    const seen = new Set();
    let matchUrl = '';
    let scanned = 0;
    let total = null;
    for (const p of pages) {
      if (!p.ok) continue;
      scanned += p.data.searchResult.length;
      total = p.data.pagination?.totalItem ?? total;
      for (const row of p.data.searchResult) {
        if (nameKey(row.companyName) !== key) continue;
        const id = String(row.companyId || '');
        if (seen.has(id)) continue;
        seen.add(id);
        if (!matchUrl) matchUrl = p.url;
        records.push({
          company_id: id,
          name: row.companyName,
          province: row.province ?? null,
          total_projects: row.totalProject ?? null,
          total_contract_money: row.totalContractMoney ?? null,
          total_budget_money: row.totalBudgetMoney ?? null,
          has_corruption_risk: row.hasCorruptionRisk ?? null,
        });
      }
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: matchUrl,
        excerpt: records.map((r) => `${r.name} (${r.company_id})`).join('; ').slice(0, 500) };
    }

    // No match. Only a clean answer for every page counts as not_found; a refused or failed page is a couldnt_check.
    const failed = pages.filter((p) => !p.ok);
    if (failed.length) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      const worst = failed.slice().sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
      return { status: 'couldnt_check', reason: worst.reason, records: [], source_url: worst.url, excerpt: worst.excerpt };
    }

    return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
      excerpt: `No company named "${text}" among the first ${scanned} results of ${total ?? 'an unknown number of'} for this search` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
