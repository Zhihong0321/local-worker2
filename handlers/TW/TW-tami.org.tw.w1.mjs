export const meta = { task: 'TW-tami.org.tw', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'member_no', 'registration_no', 'address', 'detail_url'],
  canary: { found: '全得工程有限公司', not_found: '不存在測試機械股份有限公司' } };

const BASE = 'https://www.tami.org.tw/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_RECORDS = 5;
// Chinese legal-form suffixes, longest first. Only the trailing one is removed.
const LEGAL_SUFFIXES = ['股份有限公司', '有限公司', '股份有限', '有限', '公司'];

function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: NFKC, parenthesised branch notes removed, 臺 treated as 台, lower case, punctuation removed, trailing legal form removed. */
function nameKey(name) {
  let s = (name || '').normalize('NFKC');
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  s = s.replace(/臺/g, '台').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  for (const suffix of LEGAL_SUFFIXES) {
    if (s.endsWith(suffix) && s.length > suffix.length) return s.slice(0, -suffix.length);
  }
  return s;
}

function searchUrlFor(term) {
  return BASE + 'iCom-list/lang/cht/ctgr_id/-/search/' + encodeURIComponent(term);
}

async function getText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept': 'text/html,*/*;q=0.8', 'accept-language': 'zh-TW,zh;q=0.9,en;q=0.5', ...extraHeaders },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, text: res.ok ? await res.text() : '' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const typed = String(keyword || '').trim();
  const listPage = BASE + 'member/list?Search=' + encodeURIComponent(typed);
  try {
    // Legal form is dropped for the search so that "X 股份有限公司" and "X 有限公司" reach the same candidates.
    let term = typed.normalize('NFKC').replace(/\s+/g, '');
    for (const suffix of LEGAL_SUFFIXES) {
      if (term.endsWith(suffix) && term.length > suffix.length) { term = term.slice(0, -suffix.length); break; }
    }
    // The directory lists Chinese names only: a name with no Chinese characters cannot be matched here, so it is not "not_found".
    if (!/\p{Script=Han}/u.test(typed)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: listPage, excerpt: 'name has no Chinese characters; the TAMI member list is in Chinese only' };
    }
    if (!term || term === '-') {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: listPage, excerpt: 'no searchable name left after removing the legal form' };
    }

    const searchUrl = searchUrlFor(term);
    const res = await getText(searchUrl, { 'x-requested-with': 'XMLHttpRequest', 'referer': listPage });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (res.status !== 200) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = res.text.replace(/<!--[\s\S]*?-->/g, '');
    const table = (html.match(/<table[^>]*id="com_list"[\s\S]*?<\/table>/) || [null])[0];
    if (!table) {
      const blocked = /captcha|驗證碼|recaptcha|cf-chl|access denied/i.test(html);
      return {
        status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url: searchUrl,
        excerpt: cleanText(html).slice(0, 300),
      };
    }

    const key = nameKey(typed);
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((m) => m[1])
      .filter((r) => /<td/.test(r))
      .map((r) => {
        const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
        const link = (r.match(/href="member\/detail\/([^"]+)"/) || [])[1] || '';
        return { name: cleanText(cells[0]), registration_no: cleanText(cells[1]), address: cleanText(cells[2]), id: link };
      })
      .filter((r) => r.name);

    if (rows.length === 0 && !/com_list/.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const matches = key ? rows.filter((r) => nameKey(r.name) === key && r.id) : [];

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: listPage,
        excerpt: `search returned ${rows.length} row(s); none has the same name as "${typed}"`,
      };
    }

    // Only the search list is read. Fetching a second page on this host makes the Windows worker runtime abort on exit,
    // and the list already gives the legal name, registration number and address.
    const records = matches.slice(0, MAX_RECORDS).map((m) => ({
      name: m.name,
      member_no: m.id,
      registration_no: m.registration_no,
      address: m.address.replace(/^\d{0,5}[_\-\s]+/, ''),
      detail_url: BASE + 'member/detail/' + m.id,
    }));

    return {
      status: 'found', reason: '', records,
      source_url: records[0].detail_url,
      excerpt: `${matches.length} TAMI member record(s) named "${matches[0].name}" (registration ${matches[0].registration_no})`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [],
      source_url: listPage, excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
