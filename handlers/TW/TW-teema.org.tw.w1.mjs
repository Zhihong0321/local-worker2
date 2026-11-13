export const meta = {
  task: 'TW-teema.org.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['companyAccount', 'name', 'name_en', 'tax_id', 'president', 'address', 'phone', 'fax', 'email', 'website',
    'capital', 'employees', 'member_class', 'main_products', 'detail_url'],
  canary: { found: '台達電子工業股份有限公司', not_found: '不存在科技股份有限公司測試用' },
};

const BASE = 'https://b2b.teema.org.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Legal-form words removed from both sides before comparing names (longest first).
const LEGAL = ['股份有限公司', '有限公司', '股份有限', '有限', '公司', 'coltd', 'ltd', 'limited', 'inc', 'corporation', 'corp', 'co', 'company'];

function core(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of LEGAL) {
      if (t.length > f.length && t.endsWith(f)) { t = t.slice(0, -f.length); changed = true; }
    }
  }
  return t;
}

// Search term: the name as typed, with trailing legal-form words removed (the site stores them, the search matches on the name).
function searchTerm(keyword) {
  let t = String(keyword || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of ['股份有限公司', '有限公司', '股份有限', '有限', '公司']) {
      if (t.length > f.length && t.endsWith(f)) { t = t.slice(0, -f.length).trim(); changed = true; }
    }
  }
  return t;
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function nz(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function failReason(err) {
  const name = String(err?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const searchUrl = '';
  let url = searchUrl;
  try {
    if (!/[㐀-鿿]/.test(kw)) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + '/CompanyList.aspx',
        excerpt: 'This site searches Chinese company names only; the keyword has no Chinese characters, so it cannot be checked here.',
      };
    }
    const term = searchTerm(kw);
    if (!core(term)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + '/CompanyList.aspx', excerpt: 'Keyword is empty after removing the legal form.' };
    }

    url = `${BASE}/CompanyList.aspx?company=${encodeURIComponent(term)}`;
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'zh-TW,zh;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();

    if (!html.includes('id="tblCompanyList"')) {
      if (/captcha|驗證碼/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'captcha or bot check on the search page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: clean(html).slice(0, 300) };
    }

    // Result rows: <a href="CompanyDetail.aspx?companyAccount=590029"> name</a>
    const rows = [];
    const seen = new Set();
    for (const m of html.matchAll(/<a href="CompanyDetail\.aspx\?companyAccount=(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      rows.push({ account: m[1], name: clean(m[2]) });
    }

    const want = core(kw);
    const matches = rows.filter((r) => core(r.name) === want);

    if (matches.length === 0) {
      // A second results page would hold more rows; the match could be there, so do not call it not found.
      if (html.includes('lnkPage_1')) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: url,
          excerpt: `Search has more than one result page and no exact match on page 1 (${rows.length} rows shown).` };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: rows.length
          ? `Search returned ${rows.length} row(s), none matching the name: ${rows.map((r) => r.name).slice(0, 5).join(' | ')}`
          : 'Search returned 0 results',
      };
    }

    const details = await Promise.all(matches.slice(0, 5).map(async (m) => {
      const detailUrl = `${BASE}/CompanyDetail.aspx?companyAccount=${m.account}`;
      try {
        const r = await fetch(`${BASE}/api/B2BCompanyInfomation/view/${m.account}`, {
          headers: { 'user-agent': UA, 'accept': 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' },
          signal: AbortSignal.timeout(25000),
        });
        if (!r.ok) return { m, detailUrl, error: `HTTP ${r.status}` };
        const d = await r.json();
        if (!d || d.error) return { m, detailUrl, error: 'no detail record' };
        return { m, detailUrl, d };
      } catch (err) {
        return { m, detailUrl, error: failReason(err) };
      }
    }));

    const records = details.map(({ m, detailUrl, d, error }) => {
      if (!d) {
        return { companyAccount: m.account, name: m.name, name_en: '', tax_id: '', president: '', address: '', phone: '', fax: '',
          email: '', website: '', capital: '', employees: '', member_class: '', main_products: '', detail_url: detailUrl, detail_error: error };
      }
      return {
        companyAccount: nz(d.companyAccount) || m.account,
        name: nz(d.companyName_cht) || m.name,
        name_en: nz(d.companyName_en),
        tax_id: nz(d.companyTaxId),
        president: nz(d.president_cht),
        address: nz(d.companyAddress_cht),
        phone: nz(d.companyTel_number),
        fax: nz(d.companyFax_number),
        email: nz(d.companyEMail),
        website: nz(d.CmpWebSite),
        capital: nz(d.CapitalAmt),
        employees: nz(d.EmpCount),
        member_class: nz(d.B2B_MemberClass),
        main_products: nz(d.B2B_PdtChDescription),
        detail_url: detailUrl,
      };
    });

    // Two requests went out on keep-alive sockets. On Windows Node 24 the runner's process.exit() right after
    // the answer can crash while one of those sockets is still closing; a short pause lets them close first.
    await new Promise((resolve) => setTimeout(resolve, 400));

    return {
      status: 'found', reason: '', records, source_url: url,
      excerpt: `${matches.length} exact match(es) on the search page: ` + matches.map((m) => m.name).join(' | ')
        + '. ' + clean(records.map((r) => r.name + ' / ' + r.tax_id + ' / ' + r.address).join(' ; ')).slice(0, 300),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: failReason(err), records: [], source_url: url || BASE + '/CompanyList.aspx', excerpt: String(err?.message || err).slice(0, 300) };
  }
}
