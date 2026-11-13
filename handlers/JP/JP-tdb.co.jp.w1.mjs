export const meta = {
  task: 'JP-tdb.co.jp',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_code', 'address', 'industry'],
  canary: { found: 'トヨタ自動車株式会社', not_found: 'ゼズネア株式会社' },
};

// TDB企業サーチ: the free company-name search (no login, no payment). Only the result list is read.
// The paid 会社情報 (500円/件) detail pages are never requested.
const BASE = 'https://www.tdb.co.jp/service/u/1005.jsp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Japanese legal-form words, longest first so that 特例有限会社 is removed before 有限会社.
const LEGAL_FORMS = [
  '特例有限会社', '株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '相互会社',
  '特定非営利活動法人', '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人',
  '社団法人', '財団法人', '医療法人', '学校法人', '宗教法人',
];

/** Remove legal form (株式会社 etc., also the short (株) forms), wherever it sits in the name. */
function stripLegal(s) {
  let t = (s || '').normalize('NFKC');
  t = t.replace(/\((株|有|合|同|名|相|特|社|財|医|宗|学)\)/g, '');
  for (const lf of LEGAL_FORMS) t = t.split(lf).join('');
  return t.trim();
}

/** Comparable form of a name: no legal form, no spaces or punctuation, lower case. */
function core(s) {
  return stripLegal(s).toLowerCase().replace(/[\s　.,・･\-_\/&()'"’“”]/g, '');
}

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Result rows: each row has a div.table_code (TDB company code), p.table_about_name, p.table_about_address. */
function parseRows(html) {
  const rows = [];
  for (const part of html.split('<div role="row">').slice(1)) {
    const code = part.match(/<div class="table_code"[^>]*>([\s\S]*?)<\/div>/);
    const name = part.match(/<p class="table_about_name"[^>]*>([\s\S]*?)<\/p>/);
    if (!code || !name) continue;
    const addr = part.match(/<p class="table_about_address"[^>]*>([\s\S]*?)<\/p>/);
    const ind = part.match(/<div class="table_industry"[^>]*>([\s\S]*?)<\/div>/);
    rows.push({
      company_code: clean(code[1]),
      name: clean(name[1]),
      address: addr ? clean(addr[1]) : '',
      industry: ind ? clean(ind[1]) : '',
    });
  }
  return rows;
}

/**
 * One search request. Returns { ok: true, rows, count, url, text } or { ok: false, reason, url, excerpt }.
 * accord: '2' = 完全一致 (exact), '' = the site's default 前方一致 (prefix).
 */
async function search(query, accord) {
  const url = `${BASE}?companyName=${encodeURIComponent(query)}` + (accord ? `&companyNameAccord=${accord}` : '');
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.5' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: 'http_error', url, excerpt: `HTTP ${res.status}` };

  const html = await res.text();
  const countMatch = html.match(/検索結果：<span>([\d,]+)件/);
  const noData = html.includes('該当するデータが見つかりません');
  if (!countMatch && !noData) {
    if (/captcha|cf-chl|challenge-platform|Access Denied|Attention Required/i.test(html)) {
      return { ok: false, reason: 'blocked', url, excerpt: clean(html).slice(0, 300) };
    }
    return { ok: false, reason: 'layout_changed', url, excerpt: clean(html).slice(0, 300) };
  }
  const count = countMatch ? Number(countMatch[1].replace(/,/g, '')) : 0;
  const rows = count > 0 ? parseRows(html) : [];
  if (count > 0 && rows.length === 0) {
    return { ok: false, reason: 'layout_changed', url, excerpt: clean(html).slice(0, 300) };
  }
  return { ok: true, rows, count, url, text: clean(html) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = (keyword || '').normalize('NFKC').trim();
  try {
    if (!core(name)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'the input has no company name part' };
    }
    const want = core(name);

    // Attempt 1: exact match (完全一致) on the name as typed.
    // Attempt 2: default prefix match on the name without legal form (前方一致), which catches 株式会社 placed elsewhere.
    // Two requests at most, so the call stays well under 60 s.
    const attempts = [
      { query: name, accord: '2' },
      { query: stripLegal(name) || name, accord: '' },
    ];

    let last = null;
    for (const a of attempts) {
      const r = await search(a.query, a.accord);
      if (!r.ok) {
        return { status: 'couldnt_check', reason: r.reason, records: [], source_url: r.url, excerpt: r.excerpt };
      }
      last = r;
      const matches = r.rows.filter((row) => core(row.name) === want);
      if (matches.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: matches.map((m) => ({ name: m.name, company_code: m.company_code, address: m.address, industry: m.industry })),
          source_url: r.url,
          excerpt: `検索結果 ${r.count}件: ` + matches.map((m) => `${m.name} / ${m.address}`).join('; ').slice(0, 400),
        };
      }
    }

    // Both searches answered normally and no listed name matches.
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: last.url,
      excerpt: `${last.text.match(/該当するデータが見つかりません/) ? '該当するデータが見つかりません' : `検索結果 ${last.count}件, no matching name`}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: `${BASE}?companyName=${encodeURIComponent(name)}`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
