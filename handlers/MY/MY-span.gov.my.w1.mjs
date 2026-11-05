export const meta = {
  task: 'MY-span.gov.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'register', 'licence_type', 'licence_no', 'state', 'expiry'],
  canary: { found: 'AEON CO. (M) BHD', not_found: 'O2O Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CLASS_URL = 'https://eclaps.span.gov.my/article/view/lesen-kelas';
const PERMIT_URL = 'https://eclaps.span.gov.my/view/ipa-permit-type-a1-a2-1';
const PERMIT_API = PERMIT_URL + '/filter';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) => String(s == null ? '' : s)
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const strip = (s) => String(s == null ? '' : s)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

async function getText(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      ...opts,
      signal: ctl.signal,
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
    });
    const text = await res.text();
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', status: res.status, text: '' };
    if (!res.ok) return { ok: false, reason: 'http_error', status: res.status, text: '' };
    return { ok: true, status: res.status, text, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
  } catch (e) {
    return { ok: false, reason: /abort/i.test(String(e && e.name) + ' ' + String(e && e.message)) ? 'timeout' : 'other', status: 0, text: '' };
  } finally {
    clearTimeout(t);
  }
}

/** Class licensee register: one plain GET, the whole table (1755 rows) sits in the HTML. */
async function classLicensees(keyword) {
  const r = await getText(CLASS_URL);
  if (!r.ok) return { status: 'error', reason: r.reason, detail: 'class licensee page: HTTP ' + r.status };
  const html = r.text;
  if (!/id="table-dashboard"/.test(html) || !/CLASS LICENSEE/i.test(html)) {
    return { status: 'error', reason: 'layout_changed', detail: 'class licensee table marker missing' };
  }
  const tbody = html.split('<tbody>')[1];
  if (!tbody) return { status: 'error', reason: 'layout_changed', detail: 'class licensee tbody missing' };
  const rows = [...tbody.split('</tbody>')[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1]))
  );
  if (rows.length < 500) return { status: 'error', reason: 'layout_changed', detail: 'only ' + rows.length + ' class licensee rows' };
  const q = norm(keyword);
  if (!q) return { status: 'ok', records: [], checked: rows.length };
  const hits = rows.filter((c) => norm(c[1]).includes(q)).map((c) => ({
    name: c[1],
    register: 'class licensee',
    licence_type: 'Class Licence (Lesen Kelas)',
    licence_no: c[4] || c[5] || '',
    state: c[3] || '',
    expiry: c[7] || '',
    _raw: c.join(' | '),
  }));
  return { status: 'ok', records: hits, checked: rows.length };
}

let permitSession = null; // {token, cookie, at}

async function permitAuth() {
  if (permitSession && Date.now() - permitSession.at < 10 * 60 * 1000) return { ok: true, ...permitSession };
  const page = await getText(PERMIT_URL);
  if (!page.ok) return { ok: false, reason: page.reason, detail: 'permit page: HTTP ' + page.status };
  const tok = /name="csrf-token"\s+content="([^"]+)"/.exec(page.text);
  if (!tok) return { ok: false, reason: 'layout_changed', detail: 'permit page CSRF meta missing' };
  if (!/IPA Permit Type/i.test(page.text)) return { ok: false, reason: 'layout_changed', detail: 'permit page title marker missing' };
  const cookie = page.setCookie.map((c) => c.split(';')[0]).join('; ');
  permitSession = { token: tok[1], cookie, at: Date.now() };
  return { ok: true, ...permitSession };
}

/** One DataTables POST to the permit filter endpoint. */
async function permitPost(token, cookie, searchValue, length) {
  const body = new URLSearchParams();
  body.set('draw', '1');
  body.set('start', '0');
  body.set('length', String(length));
  body.set('searchItem', searchValue);
  body.set('_token', token);
  body.set('search[value]', searchValue);
  body.set('search[regex]', 'false');
  for (let i = 0; i < 9; i++) {
    body.set('columns[' + i + '][data]', 'c' + i);
    body.set('columns[' + i + '][name]', '');
    body.set('columns[' + i + '][searchable]', 'true');
    body.set('columns[' + i + '][orderable]', 'true');
    body.set('columns[' + i + '][search][value]', '');
    body.set('columns[' + i + '][search][regex]', 'false');
  }
  body.set('order[0][column]', '1');
  body.set('order[0][dir]', 'asc');

  const r = await getText(PERMIT_API, {
    method: 'POST',
    body: body.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      referer: PERMIT_URL,
      origin: 'https://eclaps.span.gov.my',
      ...(cookie ? { cookie } : {}),
    },
  });
  if (!r.ok) return { ok: false, reason: r.reason, detail: 'permit filter: HTTP ' + r.status };
  let j;
  try { j = JSON.parse(r.text); } catch (e) { return { ok: false, reason: 'layout_changed', detail: 'permit filter did not return JSON' }; }
  if (!j || typeof j.recordsTotal !== 'number' || !Array.isArray(j.data)) {
    return { ok: false, reason: 'layout_changed', detail: 'permit filter JSON shape changed' };
  }
  return { ok: true, json: j };
}

/** IPA permit register A1/A2 (4671 records): the page carries a CSRF token, then POST filters server-side. */
async function ipaPermits(keyword) {
  const auth = await permitAuth();
  if (!auth.ok) return { status: 'error', reason: auth.reason, detail: auth.detail };

  // probe with an empty search first: the endpoint reports the unfiltered total only then
  const probe = await permitPost(auth.token, auth.cookie, '', 1);
  if (!probe.ok) return { status: 'error', reason: probe.reason, detail: probe.detail };
  const total = probe.json.recordsTotal;
  if (total < 1000) return { status: 'error', reason: 'layout_changed', detail: 'permit register only ' + total + ' rows' };

  await sleep(1100);
  const res = await permitPost(auth.token, auth.cookie, keyword, 50);
  if (!res.ok) return { status: 'error', reason: res.reason, detail: res.detail };
  const j = res.json;
  const q = norm(keyword);
  const toRecord = (row) => ({
    name: row[1] || '',
    register: 'IPA permit A1/A2',
    licence_type: row[5] || '',
    licence_no: row[6] || '',
    state: row[3] || '',
    expiry: row[8] || '',
    _raw: row.join(' | '),
  });
  const rows = j.data || [];
  let hits = rows.filter((row) => !q || norm(row.join(' ')).includes(q));
  // the server matched the phrase but no single row held it verbatim: keep the server's rows, not a false not_found
  if (!hits.length && rows.length) hits = rows;
  return { status: 'ok', records: hits.map(toRecord), checked: total, filtered: j.recordsFiltered };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  const source_url = CLASS_URL + ' , ' + PERMIT_URL;
  try {
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'empty keyword' };

    const a = await classLicensees(kw);
    await sleep(1100);
    const b = await ipaPermits(kw);

    const errs = [];
    if (a.status === 'error') errs.push('class licensees: ' + a.reason + ' (' + a.detail + ')');
    if (b.status === 'error') errs.push('IPA permits: ' + b.reason + ' (' + b.detail + ')');

    const records = [...(a.records || []), ...(b.records || [])];
    if (records.length) {
      const excerpt = records.slice(0, 3).map((r) => r._raw).join(' || ').slice(0, 500);
      return {
        status: 'found',
        reason: '',
        records: records.slice(0, 10).map(({ _raw, ...rest }) => rest),
        source_url,
        excerpt,
      };
    }

    if (errs.length === 2) {
      const reason = (a.reason === 'blocked' || b.reason === 'blocked') ? 'blocked'
        : (a.reason === 'layout_changed' || b.reason === 'layout_changed') ? 'layout_changed'
          : (a.reason === 'timeout' || b.reason === 'timeout') ? 'timeout' : 'other';
      return { status: 'couldnt_check', reason, records: [], source_url, excerpt: errs.join(' ; ').slice(0, 500) };
    }
    if (errs.length === 1) return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: errs[0].slice(0, 500) };

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: 'no match for "' + kw + '" in ' + a.checked + ' class licensees and ' + b.checked + ' IPA A1/A2 permits',
    };
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: String((e && e.message) || e).slice(0, 500) };
  }
}
