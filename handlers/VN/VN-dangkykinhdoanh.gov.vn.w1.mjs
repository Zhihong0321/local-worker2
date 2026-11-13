export const meta = { task: 'VN-dangkykinhdoanh.gov.vn', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'enterprise_code', 'gdt_code', 'site_id', 'match'],
  canary: { found: 'CÔNG TY TNHH VINGROUP VIỆT NAM', not_found: 'CÔNG TY TNHH KHÔNG TỒN TẠI XYZ 12345' } };

// The site's enterprise-name search box calls this AJAX endpoint with the search text and a token that is
// written into the home page. The reply is a JS array of up to 10 suggestions: name, enterprise code, tax (GDT) code.
const BASE = 'https://dangkykinhdoanh.gov.vn';
const PAGE = BASE + '/vn/Pages/Trangchu.aspx';
const AJAX = BASE + '/_layouts/15/NCS.Control.QTDKDN/Ajax/SorlSearchEnterpriseName.ashx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CAP = 10; // the endpoint returns at most this many suggestions
// Vietnamese legal-form words, removed before comparing names (the site writes "CP" and "CỔ PHẦN" for the same form).
const LEGAL = ['cong ty', 'cong ty cp', 'tnhh', 'tnhh mtv', 'mot thanh vien', 'co phan', 'cp', 'mtv',
  'doanh nghiep tu nhan', 'dntn', 'hop tac xa'].sort((a, b) => b.length - a.length);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function core(s) {
  let t = ' ' + fold(s) + ' ';
  for (const w of LEGAL) t = t.split(' ' + w + ' ').join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*;q=0.8', 'Accept-Language': 'vi,en;q=0.8' };

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  try {
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: AJAX, excerpt: 'empty keyword' };

    // 1. The home page: read the search token the site itself uses.
    const pageRes = await fetch(PAGE, { headers, signal: AbortSignal.timeout(25000) });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${pageRes.status}` };
    }
    if (!pageRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${pageRes.status}` };
    }
    const pageHtml = await pageRes.text();
    const tokenMatch = pageHtml.match(/h:\s*"(\d+-[0-9A-Fa-f]+)"/);
    if (!tokenMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: 'no search token found on the home page' };
    }

    // 2. The name search: the same POST the search box sends.
    const body = new URLSearchParams({ searchField: kw, h: tokenMatch[1], lang: 'vi' });
    const res = await fetch(AJAX, {
      method: 'POST',
      body,
      headers: { ...headers, 'X-Requested-With': 'XMLHttpRequest', 'Referer': PAGE, 'Accept': 'text/plain,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: AJAX, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: AJAX, excerpt: `HTTP ${res.status}` };
    }
    const text = (await res.text()).trim();
    if (text === 'RELOAD') {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: AJAX, excerpt: 'the site ended the session (RELOAD)' };
    }
    if (text === '[]') {
      return { status: 'not_found', reason: '', records: [], source_url: AJAX, excerpt: `0 suggestions for "${kw}"` };
    }
    if (!text.startsWith('[')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: AJAX, excerpt: text.slice(0, 300) };
    }

    // 3. Parse the suggestions: {Id:'…', Name:'<div><b>NAME</b><br/>Enterprise code: …; Enterprise gdt code: …</div>'}
    const items = [...text.matchAll(/\{Id:'([^']*)',\s*Name:'([\s\S]*?)'\}/g)].map((m) => {
      const html = m[2];
      return {
        id: m[1],
        name: stripTags((html.match(/<b>([\s\S]*?)<\/b>/) || [])[1] || ''),
        enterprise_code: ((html.match(/Enterprise code:\s*(\d+)/) || [])[1]) || '',
        gdt_code: ((html.match(/Enterprise gdt code:\s*([\d-]*)/) || [])[1] || '').trim(),
      };
    }).filter((x) => x.name);
    if (items.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: AJAX, excerpt: text.slice(0, 300) };
    }

    // 4. Match the company, not similar words: same name after case, accents, punctuation and legal form are removed.
    const want = core(kw);
    const matches = items.filter((x) => want && core(x.name) === want);
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((x) => ({
          name: x.name,
          enterprise_code: x.enterprise_code, // blank when the suggestion omits it (the site does this for some single matches)
          gdt_code: x.gdt_code,
          site_id: x.id,
          match: fold(x.name) === fold(kw) ? 'exact' : 'legal-form-normalised',
        })),
        source_url: AJAX,
        excerpt: matches.map((x) => `${x.name} | site id ${x.id}${x.enterprise_code ? ' | enterprise code ' + x.enterprise_code : ''}`).join(' ; ').slice(0, 500),
      };
    }

    // The endpoint stops at 10 suggestions: a full list may hide the company, so that is not a "not found".
    if (items.length >= CAP) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: AJAX,
        excerpt: `the site returned its maximum of ${CAP} suggestions and none matched exactly; the name may be further down`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: AJAX,
      excerpt: `${items.length} suggestion(s) for "${kw}", none with this name: ` + items.slice(0, 3).map((x) => x.name).join(' ; ').slice(0, 400),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: AJAX,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
