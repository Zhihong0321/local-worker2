export const meta = { task: 'TW-twincn.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'tax_id', 'representative', 'address', 'status', 'detail_url'],
  canary: { found: '台灣積體電路製造股份有限公司', not_found: '甲乙丙丁戊己庚辛壬癸測試不存在股份有限公司' } };

const BASE = 'https://twincn.com';
// The site serves an empty page to requests without Accept headers, so send a full browser-like set.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// Legal-form words are removed before comparing, so "X 股份有限公司" matches "X" and "(股)" matches "股份有限公司".
const CJK_FORMS = ['股份有限公司', '有限責任', '有限公司', '股份有限', '公司', '(股)', '(有)', '股份', '有限', '企業社']
  .sort((a, b) => b.length - a.length);

function coreName(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  for (const f of CJK_FORMS) t = t.split(f).join(' ');
  t = t.replace(/\b(co\.?\s*,?\s*ltd\.?|co\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|company|llc)(?=\W|$)/g, ' ');
  return t.replace(/[^\p{L}\p{N}]+/gu, '');
}

function cleanText(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // The runner calls process.exit() as soon as this returns; on Windows (Node 24) that can race the closing
  // HTTP socket and abort with exit code 127. A short pause lets the socket close first.
  await new Promise(resolve => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  const kw = String(keyword || '').trim();
  const searchUrl = `${BASE}/Lq.aspx?q=${encodeURIComponent(kw)}`;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: searchUrl,
    excerpt: cleanText(excerpt).slice(0, 300) });
  try {
    if (!kw) return fail('other', 'empty keyword');

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    const html = await res.text();
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
    if (html.trim().length < 50) return fail('blocked', `empty page (${html.length} bytes)`);
    if (html.includes('SORRY!')) return fail('other', 'site returned its error page (SORRY!)');
    if (!html.includes('搜尋公司列表') || !html.includes('<tbody')) return fail('layout_changed', html);

    const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
    const rows = tbody.match(/<tr[\s\S]*?<\/tr>/g) || [];
    const target = coreName(kw);
    const records = [];

    for (const row of rows) {
      const taxMatch = row.match(/<td[^>]*>\s*(\d{8})\s*<\/td>/);
      const link = row.match(/<a href="(\/item\.aspx\?no=\d+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!taxMatch || !link) continue;
      const name = cleanText(link[2]);
      if (!target || coreName(name) !== target) continue;

      const divs = [...row.matchAll(/<div class="col-sm-auto">([\s\S]*?)<\/div>/g)].map(m => cleanText(m[1])).filter(Boolean);
      const rep = divs.find(t => /^負責人\s*[:：]/.test(t)) || '';
      const rest = divs.filter(t => t !== name && t !== rep);
      records.push({
        name,
        tax_id: taxMatch[1],
        representative: rep.replace(/^負責人\s*[:：]\s*/, ''),
        address: rest[0] || '',
        status: rest[1] || '',
        detail_url: new URL(link[1], BASE).href,
      });
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `search returned ${rows.length} row(s); none matches "${kw}"` };
    }
    return { status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: `${records.length} match(es): ` + records.map(r => `${r.name} (${r.tax_id})`).join('; ') };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return fail(reason, String((err && err.message) || err));
  }
}
