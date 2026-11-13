export const meta = {
  task: 'VN-cafef.vn',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'symbol', 'exchange', 'page_url'],
  canary: { found: 'Công ty Cổ phần Sữa Việt Nam', not_found: 'Công ty Cổ phần Gạch Men Thiên Đức' },
};

// CafeF's own company search box (cafef.vn, "Gõ mã CK hoặc tên công ty...") filters this public JSON list in the
// browser. It holds every company CafeF shows a page for: name, ticker, and the company page path.
const LIST_URL = 'https://cafef1.mediacdn.vn/Search/company.json';
const SITE = 'https://cafef.vn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EXCHANGES = { hose: 'HOSE', hastc: 'HNX', upcom: 'UPCOM', otc: 'OTC' };

// Legal-form phrases (Vietnamese and English), as normalised token sequences. They are removed only when they open or
// close a name, and only as whole phrases, so "CTCP X", "Công ty cổ phần X" and "X JSC" all compare as "x", while
// "Gạch men Thanh Thanh" keeps its "thanh" words and "Cơ điện" keeps its "co".
const LEGAL_PHRASES = [
  ['trach', 'nhiem', 'huu', 'han', 'mot', 'thanh', 'vien'],
  ['trach', 'nhiem', 'huu', 'han'],
  ['tnhh', 'mot', 'thanh', 'vien'],
  ['cong', 'ty', 'trach', 'nhiem', 'huu', 'han'],
  ['cong', 'ty', 'co', 'phan'],
  ['cong', 'ty', 'tnhh'],
  ['cong', 'ty', 'cp'],
  ['joint', 'stock', 'company'],
  ['joint', 'stock'],
  ['cong', 'ty'],
  ['co', 'phan'],
  ['ctcp'], ['cp'], ['tnhh'], ['mtv'], ['jsc'], ['ltd'], ['limited'], ['company'], ['corporation'], ['corp'],
];

const startsWithPhrase = (t, p) => p.length <= t.length && p.every((w, i) => t[i] === w);
const endsWithPhrase = (t, p) => p.length <= t.length && p.every((w, i) => t[t.length - p.length + i] === w);

/** Normalised comparison key: no diacritics, lower case, punctuation removed, legal form removed. */
function nameCore(str) {
  let t = String(str || '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of LEGAL_PHRASES) {
      if (startsWithPhrase(t, p)) { t = t.slice(p.length); changed = true; break; }
      if (endsWithPhrase(t, p)) { t = t.slice(0, t.length - p.length); changed = true; break; }
    }
  }
  return t.join(' ');
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const sourceUrl = LIST_URL;

    let res;
    try {
      res = await fetch(LIST_URL, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return fail('timeout', sourceUrl, 'the company list did not answer within 25 s');
      }
      return fail('other', sourceUrl, 'fetch failed: ' + (err && err.message));
    }

    if (res.status === 403 || res.status === 429) return fail('blocked', sourceUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', sourceUrl, `HTTP ${res.status}`);

    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return fail('timeout', sourceUrl, 'the company list body did not finish within 25 s');
      }
      return fail('other', sourceUrl, 'reading the list failed: ' + (err && err.message));
    }

    let list;
    try {
      list = JSON.parse(text);
    } catch (_) {
      if (/captcha|cf-chl|challenge|access denied/i.test(text.slice(0, 2000))) {
        return fail('blocked', sourceUrl, 'bot check page instead of the list');
      }
      return fail('layout_changed', sourceUrl, 'the list is not JSON: ' + text.slice(0, 200));
    }

    if (!Array.isArray(list) || list.length === 0) {
      return fail('layout_changed', sourceUrl, 'the list is not a non-empty array');
    }

    const rows = list.filter((r) => r && typeof r.Title === 'string' && typeof r.Symbol === 'string' && typeof r.RedirectUrl === 'string');
    if (rows.length === 0 || rows.length < list.length * 0.9) {
      return fail('layout_changed', sourceUrl, `only ${rows.length} of ${list.length} entries have the expected fields`);
    }

    const want = nameCore(keyword);
    if (!want) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: 'no company name is left after removing the legal form from the keyword',
      };
    }

    const records = [];
    for (const r of rows) {
      const m = r.RedirectUrl.match(/^\/du-lieu\/(hose|hastc|upcom|otc)\//);
      if (!m) continue; // index pages such as VN-Index are not companies
      if (nameCore(r.Title) !== want) continue;
      records.push({
        name: r.Title,
        symbol: r.Symbol,
        exchange: EXCHANGES[m[1]],
        page_url: SITE + r.RedirectUrl,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `no listed company with the name "${String(keyword)}" among ${rows.length} entries on the list`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: records.map((r) => `${r.symbol} | ${r.name} | ${r.exchange} | ${r.page_url}`).join('\n').slice(0, 300),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
