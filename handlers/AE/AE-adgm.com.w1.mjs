export const meta = {
  task: 'AE-adgm.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'fsp_number', 'fsp_date', 'firm_type', 'legal_status', 'status', 'address', 'detail_url'],
  canary: { found: 'Mirabaud (Abu Dhabi) Limited', not_found: 'شركة زكسكفوك القابضة ذ.م.م' },
};

const BASE = 'https://www.adgm.com';
const PAGE = BASE + '/public-registers/fsra';
const SEARCH_API = BASE + '/api/FSRA_AllTab/GetAllTabResponse';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['limited', 'ltd', 'llc', 'lp', 'llp', 'plc', 'inc', 'co', 'corp', 'corporation', 'company',
  'sdn', 'bhd', 'pte', 'fze', 'fzco', 'dmcc', 'gmbh', 'ag', 'sa', 'sarl']);

function words(s) {
  return String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Comparison key: letters and digits only, trailing legal-form words removed. */
function normKey(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join('');
}

/** Search text: the name as typed, minus trailing legal-form words. */
function searchText(keyword) {
  const parts = String(keyword).trim().split(/\s+/);
  while (parts.length > 1 && LEGAL.has(words(parts[parts.length - 1]).join(''))) parts.pop();
  return parts.join(' ');
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;/gi, '-')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

const HEADERS_JSON = {
  'User-Agent': UA,
  'Content-Type': 'application/json; charset=utf-8',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': BASE,
  'Referer': PAGE,
};

/** Reads one firm/fund detail page: the label/value rows of its table. */
async function readDetail(url) {
  const res = await fetch(new URL(url, BASE).href, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('detail HTTP ' + res.status);
  const html = await res.text();
  const rows = {};
  const re = /<adgm-table-cell[^>]*>([\s\S]*?)<\/adgm-table-cell>\s*<adgm-table-cell[^>]*>([\s\S]*?)<\/adgm-table-cell>/g;
  let m;
  while ((m = re.exec(html))) {
    const label = decode(m[1]);
    if (label) rows[label] = decode(m[2]);
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pageUrl = (q) => PAGE + '?query=' + encodeURIComponent(q);
  try {
    const key = normKey(keyword);
    if (!key) return fail('other', PAGE, 'empty company name');
    const query = searchText(keyword);

    let res;
    try {
      res = await fetch(SEARCH_API, {
        method: 'POST',
        headers: HEADERS_JSON,
        body: JSON.stringify({ query, numberofitems: 50 }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return fail(timedOut ? 'timeout' : 'other', pageUrl(query), String(err?.message || err));
    }
    if (res.status === 403 || res.status === 429) return fail('blocked', pageUrl(query), 'HTTP ' + res.status);
    if (!res.ok) return fail('http_error', pageUrl(query), 'HTTP ' + res.status);

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || typeof data !== 'object') {
      if (/captcha|access denied|just a moment|verify you are human/i.test(text)) return fail('blocked', pageUrl(query), text.slice(0, 200));
      return fail('layout_changed', pageUrl(query), text.slice(0, 200));
    }
    const firms = data.firms, funds = data.funds;
    if (!firms || !Array.isArray(firms.items) || !funds || !Array.isArray(funds.items)) {
      return fail('layout_changed', pageUrl(query), JSON.stringify(data).slice(0, 200));
    }

    // Firms and funds are the company-type entries of the register; individuals are people and are not returned.
    const hits = [];
    for (const [category, list] of [['firm', firms], ['fund', funds]]) {
      for (const item of list.items) {
        if (item && normKey(item.title) === key && item.url) {
          hits.push({ category, title: String(item.title), url: String(item.url) });
        }
      }
    }

    if (hits.length === 0) {
      const truncated = firms.totalitems > firms.items.length || funds.totalitems > funds.items.length;
      if (truncated) return fail('other', pageUrl(query), 'more matches than the register returned; cannot confirm absence');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl(query),
        excerpt: `FSRA register search for "${query}" returned no firm or fund named like "${keyword}"`,
      };
    }

    const records = await Promise.all(hits.map(async (hit) => {
      const rec = {
        name: hit.title,
        category: hit.category,
        fsp_number: '',
        fsp_date: '',
        firm_type: '',
        legal_status: '',
        status: '',
        address: '',
        detail_url: new URL(hit.url, BASE).href,
      };
      try {
        const rows = await readDetail(hit.url);
        rec.fsp_number = rows['FSP Number'] || '';
        rec.fsp_date = rows['FSP Date'] || '';
        rec.firm_type = rows['Firm Type'] || '';
        rec.legal_status = rows['Legal Status'] || '';
        rec.status = rows['Status'] || '';
        rec.address = rows['Address'] || '';
      } catch (err) {
        rec.detail_error = String(err?.message || err).slice(0, 100);
      }
      return rec;
    }));

    const excerpt = records.map((r) => `${r.name} (${r.category}, FSP ${r.fsp_number || '?'}, ${r.status || 'status ?'})`).join('; ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl(query),
      excerpt: excerpt.slice(0, 500),
    };
  } catch (err) {
    return fail('other', PAGE, String(err?.message || err));
  }
}
