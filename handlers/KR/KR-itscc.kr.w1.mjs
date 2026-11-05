export const meta = {
  task: 'KR-itscc.kr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['product', 'cert_no', 'holder', 'level', 'product_type', 'issued', 'expiry'],
  canary: { found: '안랩', not_found: '세무법인 혜움' },
};

const BASE = 'https://www.itscc.kr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(buf, ctype) {
  let cs = 'utf-8';
  const m = /charset=([\w-]+)/i.exec(ctype || '');
  if (m) cs = m[1].toLowerCase();
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

function strip(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse the result table (id="cplWrap") of the certified-product list page. */
function parseTable(html) {
  const idx = html.indexOf('id="cplWrap"');
  if (idx < 0) return null;
  const tail = html.slice(idx);
  const end = tail.indexOf('</table>');
  const tbl = end < 0 ? tail : tail.slice(0, end);
  const rows = [];
  for (const m of tbl.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]));
    // cells: [icon, product, cert_no, holder, level, product_type, issued (expiry)]
    if (tds.length < 6) continue;
    if (!tds[1] && !tds[2]) continue;
    const dates = tds[6] || '';
    const dm = dates.match(/([\d-]{8,10})\s*\(?([\d-]{8,10})?\)?/);
    rows.push({
      product: tds[1],
      cert_no: tds[2],
      holder: tds[3],
      level: tds[4],
      product_type: tds[5],
      issued: dm ? dm[1] : dates,
      expiry: dm && dm[2] ? dm[2] : '',
    });
  }
  return rows;
}

function lastPage(html) {
  const i = html.indexOf('class="paginate"');
  if (i < 0) return 1;
  const seg = html.slice(i, i + 4000);
  let max = 1;
  for (const m of seg.matchAll(/class="number_off fnMove" id="(\d+)"/g)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  for (const m of seg.matchAll(/class="next fnMove" id="(\d+)"/g)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

async function openSession() {
  const res = await fetch(BASE + '/main/main.do', {
    headers: { 'user-agent': UA, accept: 'text/html,*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('http_error ' + res.status);
  const html = decode(await res.arrayBuffer(), res.headers.get('content-type'));
  const m = html.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error('layout_changed: no csrf token on main page');
  return { cookie: cookieHeader(res), csrf: m[1] };
}

async function post(sess, fields) {
  const body = new URLSearchParams({
    product_class: '1',
    product_id: '0',
    selectPage: '1',
    orderBy: '',
    csrf: sess.csrf,
    searchValue: '',
    searchCertNo: '',
    searchCertHolder: '',
    searchAssuranceLevel: '',
    searchProductType: '',
    searchYear: '',
    searchEvalFacility: '',
    ...fields,
  });
  const res = await fetch(BASE + '/certprod/listA.do', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      accept: 'text/html,*/*',
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE,
      referer: BASE + '/certprod/listA.do',
      cookie: sess.cookie,
    },
    body: body.toString(),
    redirect: 'manual',
  });
  // The site rejects GET/expired-session calls with a 302 to "/": treat as session problem.
  if (res.status >= 300 && res.status < 400) return { redirect: true, status: res.status };
  if (!res.ok) return { error: 'http_error ' + res.status };
  const html = decode(await res.arrayBuffer(), res.headers.get('content-type'));
  return { html };
}

/** Run one search (holder field first, product-name as a fallback) and return pages of rows. */
async function search(sess, field, value) {
  const out = await post(sess, { [field]: value });
  if (out.redirect) return { redirect: true };
  if (out.error) return { error: out.error };
  const rows = parseTable(out.html);
  if (rows === null) return { layout: true };
  const hasNoData = out.html.includes('해당 데이터가 없습니다');
  const pages = lastPage(out.html);
  let all = rows;
  const limit = Math.min(pages, MAX_PAGES);
  for (let p = 2; p <= limit; p++) {
    await sleep(1100);
    const nx = await post(sess, { [field]: value, selectPage: String(p) });
    if (nx.redirect) break;
    if (nx.error) break;
    const r2 = parseTable(nx.html);
    if (r2 === null) break;
    if (!r2.length) break;
    all = all.concat(r2);
  }
  return { rows: all, hasNoData, pages };
}

export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  const src = BASE + '/certprod/listA.do';
  if (!kw) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: src, excerpt: 'empty keyword' };
  }
  let sess;
  try {
    sess = await openSession();
  } catch (e) {
    const msg = String(e && e.message);
    return {
      status: 'couldnt_check',
      reason: msg.startsWith('layout_changed') ? 'layout_changed' : msg.includes('http_error') ? 'http_error' : 'other',
      records: [],
      source_url: BASE + '/main/main.do',
      excerpt: msg.slice(0, 300),
    };
  }

  try {
    let res = await search(sess, 'searchCertHolder', kw);
    if (res.redirect) {
      // stale session / csrf -> one fresh attempt
      sess = await openSession();
      res = await search(sess, 'searchCertHolder', kw);
    }
    if (res.redirect) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: src, excerpt: 'POST redirected to "/" (session rejected)' };
    }
    if (res.error) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: src, excerpt: res.error };
    }
    if (res.layout) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: src,
        excerpt: 'result table id="cplWrap" not found on the list page',
      };
    }

    let records = res.rows || [];

    // Fallback: the name may only appear in the product name, not the certificate-holder field.
    if (!records.length) {
      await sleep(1100);
      let alt = await search(sess, 'searchValue', kw);
      if (alt.redirect) {
        sess = await openSession();
        alt = await search(sess, 'searchValue', kw);
      }
      if (alt.rows && alt.rows.length) {
        const needle = kw.toLowerCase();
        records = alt.rows.filter(
          (r) => (r.holder || '').toLowerCase().includes(needle) || (r.product || '').toLowerCase().includes(needle)
        );
      }
    }

    const text = records.map((r) => `${r.product} | ${r.holder} | ${r.cert_no} | ${r.level}`).join(' / ');
    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: src,
        excerpt: (`ITSCC certified products naming "${kw}": ` + text).slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: src,
      excerpt: `ITSCC certified-product list (search: 인증서보유기관="${kw}") returned no rows.`,
    };
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: src,
      excerpt: String(e && e.message).slice(0, 300),
    };
  }
}
