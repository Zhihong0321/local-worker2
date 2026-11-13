export const meta = {
  task: 'JP-jinzai.hellowork.mhlw.go.jp',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'office_name', 'licence_no', 'licence_date', 'address', 'tel', 'avg_dispatch_fee_yen', 'avg_worker_wage_yen', 'margin_rate_pct', 'detail_url'],
  canary: { found: 'Amble株式会社', not_found: 'Dezeno' },
};

// Flow (plain HTTP, no browser): 1) GET the top page for a session cookie, 2) POST the worker-dispatch
// transition (screenId 'GICB102010'), 3) POST the search form with prefecture 全国 and a partial-match name.
// The site's search only matches Latin letters and digits: a name with kanji/kana gets no matches, so
// zero results for such a name is NOT proof of absence and is reported as couldnt_check.

const BASE = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb';
const TOP = `${BASE}/GICB101010.do?action=initDisp&screenId=GICB101010`;
const TRANSITION = `${BASE}/GICB101010.do`;
const SEARCH = `${BASE}/GICB102010.do`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TOTAL_MS = 55000;

// Legal-form words, removed before comparing names (both sides).
const LEGAL = /株式会社|有限会社|合同会社|合資会社|合名会社|協同組合|co\.?\s*,?\s*ltd\.?|inc\.?|corp\.?|llc|sdn\.?\s*bhd\.?/gi;

function normalize(str) {
  return String(str || '')
    .replace(/&nbsp;|&#xa0;/gi, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(LEGAL, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function field(part, id) {
  const m = part.match(new RegExp(`id="ID_${id}"[^>]*>([\\s\\S]*?)</span>`));
  return m ? clean(m[1]) : '';
}

function parseRows(html) {
  const parts = html.split('<tr onmouseout=').slice(1);
  const rows = [];
  for (const part of parts) {
    const name = field(part, 'lbJigyonushiName');
    if (!name) continue;
    const detail = part.match(/href="(\.\/GICB102010\.do\?[^"]*action=detail[^"]*)"/);
    rows.push({
      name,
      office_name: field(part, 'lbJigyoshoName'),
      licence_no: field(part, 'lbKyokatodokedeNo'),
      licence_date: field(part, 'lbKyokatodokedeDate'),
      address: field(part, 'lbJigyoshoAddress'),
      tel: field(part, 'lbTel'),
      avg_dispatch_fee_yen: field(part, 'lbRyokinaveValue'),
      avg_worker_wage_yen: field(part, 'lbChinginaveValue'),
      margin_rate_pct: field(part, 'lbPMargin'),
      detail_url: detail ? new URL(detail[1].replace(/&amp;/g, '&'), BASE + '/').href : '',
    });
  }
  return rows;
}

function storeCookies(res, jar) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i), kv);
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + TOTAL_MS;
  const jar = new Map();
  let lastUrl = SEARCH;

  const go = (url, opts = {}) => {
    const left = deadline - Date.now();
    if (left <= 1000) throw Object.assign(new Error('the handler ran out of time'), { code: 'timeout' });
    const headers = { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', ...(opts.headers || {}) };
    if (jar.size) headers.Cookie = [...jar.values()].join('; ');
    lastUrl = url;
    return fetch(url, { ...opts, headers, redirect: 'follow', signal: AbortSignal.timeout(Math.min(25000, left)) });
  };

  try {
    const name = String(keyword || '').trim();
    // Latin search term: legal-form words removed, then only letters and digits kept.
    const term = name.normalize('NFKC').replace(LEGAL, ' ').replace(/[^A-Za-z0-9]+/g, ' ').trim();
    const tradeName = name.normalize('NFKC').replace(LEGAL, '').replace(/[\s.,]+/g, '');
    if (!term) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH,
        excerpt: 'The name has no Latin letters or digits. The site search cannot match kanji or kana names.' };
    }

    // 1) Session cookie from the top page.
    const top = await go(TOP, { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    if (top.status === 403 || top.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: TOP, excerpt: `HTTP ${top.status}` };
    }
    if (!top.ok) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: TOP, excerpt: `HTTP ${top.status}` };
    storeCookies(top, jar);
    await top.text();

    // 2) Open the worker-dispatch search screen.
    const tr = await go(TRANSITION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: TOP },
      body: new URLSearchParams({ screenId: 'GICB101010', action: 'transition', params: '0' }).toString(),
    });
    if (tr.status === 403 || tr.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: TRANSITION, excerpt: `HTTP ${tr.status}` };
    }
    if (!tr.ok) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: TRANSITION, excerpt: `HTTP ${tr.status}` };
    storeCookies(tr, jar);
    const trHtml = await tr.text();
    if (!trHtml.includes('労働者派遣事業所検索')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: TRANSITION, excerpt: trHtml.slice(0, 300) };
    }

    // 3) Search: nationwide, partial match on the business-owner name.
    const res = await go(SEARCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: SEARCH },
      body: new URLSearchParams({
        screenId: 'GICB102010', action: 'search', params: '', cbZenkoku: '1',
        cbJigyonushiName: '1', txtJigyonushiName: term,
      }).toString(),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH, excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    const sourceUrl = `${SEARCH}?screenId=GICB102010&search=${encodeURIComponent(term)}`;

    if (html.includes('検索エラー')) {
      const err = clean(html.match(/<body[\s\S]*?<\/body>/i)?.[0] || html).slice(0, 300);
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: err };
    }
    const countMatch = html.match(/id="ID_lbSearchCount"[^>]*>\s*([\d,]+)\s*</);
    if (!countMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: clean(html).slice(0, 300) };
    }
    const total = Number(countMatch[1].replace(/,/g, ''));
    const rows = parseRows(html);
    if (total > 0 && rows.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: `count ${total} but no rows parsed` };
    }

    const want = normalize(tradeName);
    const matches = rows.filter((r) => normalize(r.name) === want);
    if (matches.length) {
      return {
        status: 'found', reason: '', records: matches, source_url: sourceUrl,
        excerpt: `${matches.length} match(es) for ${name}; search returned ${total} rows`,
      };
    }
    if (total > rows.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
        excerpt: `${total} rows matched ${term}; only the first ${rows.length} are read, none equal the name` };
    }
    if (/[^\x00-\x7f]/.test(tradeName)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
        excerpt: `Search on Latin part "${term}" gave ${total} rows, none equal the name. The kanji/kana part is not searchable, so absence is not proven.` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
      excerpt: `Search for "${term}" returned ${total} rows; none equal the name` };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'timeout';
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
