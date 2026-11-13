export const meta = {
  task: 'TW-ardata.cy.gov.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ubn', 'donor_name_variants', 'address', 'donation_count', 'total_amount', 'first_date', 'last_date', 'recipients'],
  canary: { found: '山水民意研究股份有限公司', not_found: '沒有這家公司測試股份有限公司' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://ardata.cy.gov.tw/api/v1/search';
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
// Each fetch may take up to 25 s; no new page starts after 30 s, so the whole call stays under 60 s.
const NO_NEW_PAGE_AFTER_MS = 30000;

/** Comparison key: NFKC, lower case, no spaces or punctuation, trailing legal form removed. */
function nameKey(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.,，。()（）\-_·・&＆'"“”]/g, '')
    .replace(/(股份有限公司|有限公司|股份有公司|公司)$/, '');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function searchUrl(keyword, page) {
  return `${BASE}?donor=${encodeURIComponent(keyword)}&pageSize=${PAGE_SIZE}&pageNumber=${page}`;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const key = nameKey(kw);
    if (!key) return fail('other', '', 'empty company name');

    const firstUrl = searchUrl(kw, 1);
    const rows = [];
    let pageCount = 1;
    let truncated = false;

    for (let page = 1; page <= pageCount; page++) {
      if (page > MAX_PAGES) { truncated = true; break; }
      if (page > 1 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) { truncated = true; break; }

      const url = searchUrl(kw, page);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!json) {
        return fail(/challenge|Just a moment|cf-chl/i.test(text) ? 'blocked' : 'layout_changed', url, text);
      }
      if (!Array.isArray(json.data) || !json.paging) return fail('layout_changed', url, text);

      pageCount = Number(json.paging.pageCount) || 1;
      rows.push(...json.data);
    }

    // Company rows: the name matches after normalising AND the donor identifier is an 8-digit UBN
    // (individuals carry a personal ID, which is never used here).
    const isUbn = (v) => /^\d{8}$/.test(String(v || ''));
    const nameHits = rows.filter((r) => nameKey(r.donor) === key && isUbn(r.donorIdentifier));
    const ubns = [...new Set(nameHits.map((r) => String(r.donorIdentifier)))];

    if (ubns.length === 0) {
      if (truncated) {
        return fail('other', firstUrl, `search returned ${rows.length} of ${pageCount} pages; no company match in the pages read`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `search for "${kw}" returned ${rows.length} donation rows; none is a company with this name`,
      };
    }

    const records = ubns.map((ubn) => {
      const rs = rows.filter((r) => String(r.donorIdentifier) === ubn && isUbn(r.donorIdentifier));
      const variants = [...new Set(rs.map((r) => r.donor).filter(Boolean))];
      const primary = variants.find((n) => nameKey(n) === key) || variants[0] || kw;
      const dates = rs.map((r) => String(r.transactionDate || '').slice(0, 10)).filter(Boolean).sort();
      const total = rs.reduce((sum, r) => sum + (Number(r.donationAmount) || 0), 0);
      const recipients = [...new Set(rs.map((r) => [r.name, r.electionName || r.rpPartyName].filter(Boolean).join(' / ')).filter(Boolean))];
      return {
        name: primary,
        ubn,
        donor_name_variants: variants,
        address: rs.map((r) => r.donorAddress).find(Boolean) || '',
        donation_count: rs.length,
        total_amount: total,
        first_date: dates[0] || '',
        last_date: dates[dates.length - 1] || '',
        recipients: recipients.slice(0, 50),
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstUrl,
      excerpt: `${records.length} company record(s) matching "${kw}" among ${rows.length} donation rows`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', searchUrl(String(keyword || ''), 1), String(err?.message || err));
  }
}
