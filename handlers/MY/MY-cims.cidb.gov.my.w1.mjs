export const meta = {
  task: 'MY-cims.cidb.gov.my', want: 'w1', tier: 2, method: 'form_post', input: 'company name',
  fields: ['name', 'grade', 'state', 'district', 'phone', 'ppk', 'spkk', 'stb', 'status'],
  canary: { found: 'Dezeno', not_found: 'O2O Digital' },
};
const URL_ = 'https://cims.cidb.gov.my/smis/regcontractor/reglocalsearchcontractor.vbhtml';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const cell = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
export default async function lookup(keyword) {
  const out = (status, extra = {}) => ({ status, reason: '', records: [], source_url: URL_, excerpt: '', ...extra });
  try {
    const g = await fetch(URL_, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!g.ok) return out('couldnt_check', { reason: 'http_error', excerpt: `GET HTTP ${g.status}` });
    const cookie = (g.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const page = await g.text();
    if (!/name=["']?comName/i.test(page)) return out('couldnt_check', { reason: 'layout_changed', excerpt: 'search form field comName missing' });
    const records = [];
    for (const [validity, status] of [['1', 'valid'], ['2', 'expired']]) {
      await new Promise((r) => setTimeout(r, 1000));
      const body = new URLSearchParams({ comName: keyword, ComState: '', ComCategoryID: '', CidbRegno: '', seltype: '1', selvalidity: validity, ssmno: '', hdnpagesize: '50', hdnctpage: '1', hdntotpage: '0', hdnsortcol: 'ComName', hdnsortdir: '0', hdntotalrecs: '0', hdnexportopts: '0' });
      const p = await fetch(URL_, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', cookie }, body, signal: AbortSignal.timeout(30000) });
      if (!p.ok) return out('couldnt_check', { reason: 'http_error', excerpt: `POST HTTP ${p.status}` });
      const html = await p.text();
      if (/captcha/i.test(html)) return out('couldnt_check', { reason: 'blocked', excerpt: 'CAPTCHA on the result page' });
      if (!/<table/i.test(html) || !/comName/i.test(html)) return out('couldnt_check', { reason: 'layout_changed', excerpt: 'no result table or form on the answer' });
      for (const tr of html.split(/<tr/i).slice(1)) {
        const c = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cell(m[1]));
        if (c.length < 9 || !/^\d+$/.test(c[0])) continue;
        records.push({ name: c[1], grade: c[2], state: c[3], district: c[4], phone: c[5], ppk: c[7], spkk: c[8], stb: c[9] ?? '', status });
      }
    }
    if (!records.length) return out('not_found', { excerpt: `no CIMS row for "${keyword}" (valid or expired)` });
    return out('found', { records, excerpt: records.map((r) => `${r.name} ${r.grade} ${r.state} ${r.phone} ${r.status}`).join(' | ').slice(0, 500) });
  } catch (e) {
    return out('couldnt_check', { reason: /timeout/i.test(e.name) ? 'timeout' : 'other', excerpt: String(e.message).slice(0, 200) });
  }
}
