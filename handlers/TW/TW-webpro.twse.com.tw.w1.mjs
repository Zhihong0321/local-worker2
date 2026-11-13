export const meta = { task: 'TW-webpro.twse.com.tw', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'stock_code', 'title', 'event_date', 'channel', 'link'],
  canary: { found: '台積電', not_found: '不存在測試股份有限公司' } };

const API = 'https://webpro.twse.com.tw/WebPortal/service/search/investorMaterial/';
const PAGE = 'https://webpro.twse.com.tw/WebPortal/search/investor';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal forms that the site never puts in its short company names. Stripped from the end, repeatedly.
const LEGAL_SUFFIXES = ['股份有限公司', '有限責任公司', '有限公司', '股份有限', '公司'];

const hasCjk = (s) => /[㐀-鿿豈-﫿]/.test(s);
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** Normalised company core: no spaces or punctuation, no trailing legal form. */
function coreName(keyword) {
  let n = norm(keyword);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (n.endsWith(suf) && n.length > suf.length) { n = n.slice(0, -suf.length); changed = true; break; }
    }
  }
  return n;
}

const fail = (status, reason, source_url, excerpt) => ({ status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const core = coreName(keyword);
  const pageUrl = `${PAGE}?keyword=${encodeURIComponent(core)}`;
  try {
    const isCode = /^\d{4,6}$/.test(core);
    if (!core || (!hasCjk(core) && !isCode)) {
      // The site lists companies by their Chinese short name only, so a Latin-script name cannot be matched here.
      return fail('couldnt_check', 'other', pageUrl, `"${keyword}" is not in Chinese; the site lists companies by Chinese short name`);
    }

    const apiUrl = `${API}?returnType=json&phone=0&queryType=normal&keyword=${encodeURIComponent(core)}&pageNumber=1&pagingSize=100&order=eventDate&sortOrder=desc`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': PAGE },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', pageUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', pageUrl, `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|robot|challenge/i.test(text.slice(0, 2000))) return fail('couldnt_check', 'blocked', pageUrl, 'bot check page');

    let data;
    try { data = JSON.parse(text); } catch { return fail('couldnt_check', 'layout_changed', pageUrl, text.slice(0, 200)); }

    if (data?.status?.code !== '1') return fail('couldnt_check', 'other', pageUrl, `site status ${JSON.stringify(data?.status)}`);
    const total = data?.pagingObject?.totalCount;
    if (typeof total !== 'number') return fail('couldnt_check', 'layout_changed', pageUrl, text.slice(0, 200));

    let list = data?.result?.materials?.material ?? [];
    if (!Array.isArray(list)) list = [list];
    if (total > 0 && list.length === 0) return fail('couldnt_check', 'layout_changed', pageUrl, `totalCount ${total} but no materials`);

    // Match the company itself: the site's own company field, normalised, must equal the core name.
    const matches = list.filter((m) => (isCode ? String(m.agentUserName || '') === core : norm(m.agentSimpleName) === core));

    if (matches.length === 0) {
      const others = [...new Set(list.map((m) => m.agentSimpleName).filter(Boolean))].slice(0, 5);
      const note = total === 0
        ? `0 results for "${core}"`
        : `${total} keyword hit(s) for "${core}" but none tagged to this company${others.length ? ` (tagged companies: ${others.join(', ')})` : ''}`;
      return { status: 'not_found', reason: '', records: [], source_url: pageUrl, excerpt: note.slice(0, 300) };
    }

    const records = matches.map((m) => ({
      name: m.agentSimpleName || '',
      stock_code: m.agentUserName || '',
      title: m.name || '',
      event_date: String(m.eventDate || '').slice(0, 10),
      channel: m.vodChannel?.name || '',
      link: m.webLinkPath || null,
    }));
    const more = total > list.length ? `; showing ${list.length} of ${total}` : '';
    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt: `${records.length} record(s) for ${records[0].name} (${records[0].stock_code})${more}`.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail('couldnt_check', timedOut ? 'timeout' : 'other', pageUrl, String(err?.message || err));
  }
}
