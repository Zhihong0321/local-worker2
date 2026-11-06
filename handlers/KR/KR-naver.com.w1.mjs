// Naver Place listings for a search, read from Naver's mobile search page on the worker PC.
// The listings sit as data inside the page's scripts (no key, no login): every listing is kept as Naver returns it;
// which one is the company is Step 2's call. Input: the name, optionally with the area ("은민에스엔디 서울 강남구").
export const meta = {
  task: 'KR-naver.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  input: 'company name, optionally followed by the area',
  fields: ['id', 'name', 'category', 'address', 'roadAddress', 'phone', 'virtualPhone', 'visitorReviewCount', 'blogCafeReviewCount'],
  canary: { found: '은민에스엔디 서울 강남구', not_found: 'Magellan Logistics Pty Ltd' },
};

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const FIELDS = ['category', 'address', 'roadAddress', 'phone', 'virtualPhone', 'visitorReviewCount', 'blogCafeReviewCount'];

export default async function lookup(keyword) {
  const source_url = 'https://m.search.naver.com/search.naver?query=' + encodeURIComponent(keyword.trim());
  const out = (status, reason, records, excerpt) => ({ status, reason, records, source_url, excerpt: String(excerpt).slice(0, 500) });
  try {
    const r = await fetch(source_url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    const html = await r.text();
    if (r.status === 403 || r.status === 429 || /captcha|자동입력 방지|비정상적인 접근/i.test(html.slice(0, 20000))) return out('couldnt_check', 'blocked', [], html);
    if (!r.ok) return out('couldnt_check', 'http_error', [], 'HTTP ' + r.status);
    if (!/: 네이버 검색<\/title>/.test(html)) return out('couldnt_check', 'layout_changed', [], 'not a Naver search page');
    // Each listing starts with "id":"<digits>","name":"..."; its fields run until the next listing starts.
    const starts = [...html.matchAll(/"id":"(\d{6,})","name":("(?:[^"\\]|\\.)*")/g)];
    const places = new Map();
    starts.forEach((m, i) => {
      if (places.has(m[1])) return;
      const seg = html.slice(m.index, starts[i + 1]?.index ?? m.index + 3000);
      const place = { id: m[1], name: String(JSON.parse(m[2])).replace(/<\/?mark>/g, '') };
      for (const k of FIELDS) {
        const v = seg.match(new RegExp(`"${k}":("(?:[^"\\\\]|\\\\.)*")`))?.[1];
        const s = v ? String(JSON.parse(v)) : '';
        if (s) place[k] = s;
      }
      places.set(m[1], place);
    });
    const records = [...places.values()];
    if (records.length) return out('found', '', records, JSON.stringify(records));
    // A place section with no listing parsed means the data moved: say so instead of "not found".
    if (/__APOLLO_STATE__|"__typename":"Place/.test(html)) return out('couldnt_check', 'layout_changed', [], 'place data present but no listing parsed');
    return out('not_found', '', [], 'Naver search page with no Naver Place listing for ' + keyword);
  } catch (e) {
    return out('couldnt_check', e.name === 'TimeoutError' ? 'timeout' : 'other', [], String(e));
  }
}
