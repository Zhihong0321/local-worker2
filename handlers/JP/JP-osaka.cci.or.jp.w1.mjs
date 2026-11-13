export const meta = {
  task: 'JP-osaka.cci.or.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'office_name', 'address', 'capital', 'founded', 'employees', 'url', 'industry', 'pr', 'has_homepage', 'detail_url'],
  canary: { found: 'デュプロ株式会社', not_found: 'ヨタカヌケハ工房株式会社' },
};

// The OCCI member company search (大商会員広場) is served from the Business Mall site; osaka.cci.or.jp/member.html redirects there.
const BASE = 'https://www.b-mall.ne.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BUDGET_MS = 50000; // the whole call must finish in under 60 s
const MAX_RECORDS = 3;

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare company names: width (NFKC), case, spaces/punctuation and legal form are ignored. */
function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|企業組合/g, '')
    .replace(/\(株\)|\(有\)|\(合\)|\(資\)|\(名\)|\(相\)/g, '')
    .replace(/[\s　.,・･、。'"“”‘’\-‐‑–—_()（）【】\[\]「」]/g, '');
}

async function getPage(url, deadline) {
  const left = deadline - Date.now();
  if (left < 1000) throw Object.assign(new Error('out of time for this call'), { name: 'TimeoutError' });
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
    signal: AbortSignal.timeout(Math.min(25000, left)),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

/** Result rows of the company table: one entry per company (deduplicated by detail link). */
function parseRows(html) {
  const out = [];
  const seen = new Set();
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const link = row.match(/<a[^>]*href=['"]([^'"]*\/CompanyDetail-[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const detailUrl = new URL(link[1], BASE).href;
    if (seen.has(detailUrl)) continue;
    seen.add(detailUrl);
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    const idx = tds.findIndex((td) => /CompanyDetail-/.test(td));
    out.push({
      name: cleanText(link[2]),
      list_location: idx >= 0 ? cleanText(tds[idx + 1]) : '',
      pr: idx >= 0 ? cleanText(tds[idx + 2]).slice(0, 300) : '',
      has_homepage: idx >= 0 ? cleanText(tds[idx + 3]) === '有' : false,
      detail_url: detailUrl,
    });
  }
  return out;
}

function detailField(html, id) {
  const m = html.match(new RegExp(`<span id="${id}"[^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
  return m ? cleanText(m[1]) : '';
}

/** Adds the company page fields. The company page is reached through a JavaScript redirect, so the target path is read from it. */
async function enrich(row, deadline) {
  const base = { name: row.name, office_name: '', address: row.list_location, capital: '', founded: '', employees: '',
    url: '', industry: '', pr: row.pr, has_homepage: row.has_homepage, detail_url: row.detail_url };
  try {
    const entry = await getPage(row.detail_url, deadline);
    const target = entry.text.match(/var url="(\/company\/[^"]+)"/);
    if (!entry.ok || !target) return base;
    const page = await getPage(new URL(target[1], BASE).href, deadline);
    if (!page.ok) return base;
    const h = page.text;
    const urlMatch = h.match(/<dt>URL<\/dt>\s*<dd>\s*<a[^>]*href=["']?([^"'\s>]+)/i);
    return {
      ...base,
      office_name: detailField(h, 'ctl03_jigyoshoName'),
      address: detailField(h, 'addressCity') || row.list_location,
      capital: detailField(h, 'ctl03_capitalStock'),
      founded: detailField(h, 'ctl03_foundingYear'),
      employees: detailField(h, 'ctl03_employeeNumber'),
      url: urlMatch ? urlMatch[1] : '',
      industry: detailField(h, 'ctl03_gyoshuSetting'),
    };
  } catch (err) {
    return base; // the company is confirmed by the search list; the detail page is optional
  }
}

const cc = (reason, source_url, excerpt) => ({
  status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300),
});

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // On this Windows Node build the runner's process.exit() can fire while the last socket is still closing (libuv assert,
  // exit code 127). A short pause lets the sockets close first; the answer itself is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  const deadline = Date.now() + BUDGET_MS;
  const searchUrl = `${BASE}/osaka/companysearch?keyword=${encodeURIComponent(keyword)}`;
  try {
    const page = await getPage(searchUrl, deadline);
    if (page.status === 403 || page.status === 429) return cc('blocked', searchUrl, `HTTP ${page.status}`);
    if (!page.ok) return cc('http_error', searchUrl, `HTTP ${page.status}`);
    const html = page.text;
    if (/captcha|reCAPTCHA/i.test(html)) return cc('blocked', searchUrl, 'captcha on search page');

    const totalMatch = html.match(/企業ＤＢ検索結果：\s*([\d,]+)件/);
    const zero = /該当する企業はありませんでした/.test(html) || (totalMatch && totalMatch[1] === '0');
    if (!totalMatch && !zero) return cc('layout_changed', searchUrl, cleanText(html).slice(0, 300));

    const rows = parseRows(html);
    if (!zero && rows.length === 0) return cc('layout_changed', searchUrl, `results reported but no company rows: ${cleanText(html).slice(0, 200)}`);

    const kn = normalize(keyword);
    const matches = kn ? rows.filter((r) => normalize(r.name) === kn) : [];

    if (matches.length === 0) {
      const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : 0;
      if (!zero && total > rows.length) {
        return cc('other', searchUrl, `${total} results, the first page has no exact name match; not checked further`);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 companies with this name in the search results for ${keyword}`,
      };
    }

    const records = [];
    for (const m of matches.slice(0, MAX_RECORDS)) records.push(await enrich(m, deadline));

    return {
      status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: records.map((r) => `${r.name} | ${r.address} | ${r.industry}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return cc(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
