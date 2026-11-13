export const meta = {
  task: 'NZ-fspr.companiesoffice.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'fsp_number', 'nzbn', 'status', 'registration_date', 'deregistration_date', 'address', 'trading_names', 'previous_names', 'matched_on'],
  canary: { found: 'WESTPAC NEW ZEALAND LIMITED', not_found: 'Te Kainga Putea Turutu Limited' },
};

// The listed address (fspr.companiesoffice.govt.nz) does not resolve in DNS. The register is reached from the
// official site (https://www.companiesoffice.govt.nz/) at fsp-register.companiesoffice.govt.nz, whose
// "Search for an FSP" is the ORP application below. The search is a session-bound form POST (no JSON API).
const APP = 'https://fsp-app.companiesoffice.govt.nz';
const START = `${APP}/orp-master/service/create.html?targetAppCode=orp-master&service=registerItemSearch`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FRAG_ID = '99001';
const PAGE_200 = '4';          // the page-size option that shows 200 rows
const MAX_PAGES = 5;           // at most 1000 rows are read; more than that is couldnt_check
const DEADLINE_MS = 50000;     // the whole call must finish in under 60 s
const LEGAL = new Set(['LIMITED', 'LTD', 'INCORPORATED', 'INC', 'COMPANY', 'CO']);

class Stop extends Error {
  constructor(reason, excerpt, sourceUrl) {
    super(excerpt);
    this.reason = reason;
    this.sourceUrl = sourceUrl || START;
  }
}

function decode(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Upper-case words without accents or punctuation, parenthesised codes removed. */
function tokens(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\([^)]*\)/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Name for comparison: legal form words (LIMITED, LTD, ...) dropped on both sides. */
function normName(s) {
  return tokens(s).filter((w) => !LEGAL.has(w)).join(' ');
}

function attr(tag, name) {
  const m = String(tag).match(new RegExp('\\s' + name + '="([^"]*)"', 'i'));
  return m ? m[1] : null;
}

class Session {
  constructor() { this.jar = new Map(); }
  store(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '') this.jar.delete(name); else this.jar.set(name, value);
    }
  }
  header() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
}

/** One request with manual redirects so every Set-Cookie on the way is kept. */
async function request(sess, url, opts = {}) {
  let current = url;
  let method = opts.method || 'GET';
  let body = opts.body;
  for (let hop = 0; hop < 6; hop++) {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-NZ,en;q=0.9',
      ...(opts.headers || {}),
    };
    const ck = sess.header();
    if (ck) headers['Cookie'] = ck;
    const res = await fetch(current, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    sess.store(res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      method = 'GET';
      body = undefined;
      await res.text().catch(() => '');
      continue;
    }
    const text = await res.text();
    return { status: res.status, url: current, text };
  }
  throw new Stop('other', 'too many redirects from ' + url);
}

function checkBlocked(r) {
  if (r.status === 403 || r.status === 429) throw new Stop('blocked', `HTTP ${r.status} at ${r.url}`, r.url);
  if (/\/auth\/logon|realMeLogon/i.test(r.url)) throw new Stop('blocked', 'login wall: ' + r.url, r.url);
  if (/Request unsuccessful\.|Incapsula incident/i.test(r.text)) throw new Stop('blocked', 'bot check page at ' + r.url, r.url);
  if (r.status !== 200) throw new Stop('http_error', `HTTP ${r.status} at ${r.url}`, r.url);
}

/** Reads the search form: the page's own URL, session key, the search button and the result container. */
function parseView(html, url) {
  const formTag = html.match(/<form\b[^>]*\bid="viewInstanceForm"[^>]*>/i);
  const vik = html.match(/viewInstanceKey:\s*'([^']+)'/);
  const container = html.match(/containerNodeId:\s*'(W\d+)'/);
  const searchBtn = html.match(/<[a-z]+\b[^>]*\bappSearchButton\b[^>]*\sid="node(W\d+)"/i);
  if (!formTag || !vik || !container || !searchBtn || !/name="QueryString"/.test(html)) return null;
  const action = decode(attr(formTag[0], 'action') || '');
  if (!action) return null;
  return { action, vik: vik[1], container: container[1], searchNode: searchBtn[1], url };
}

/** Every named field of the search form, with the query put into QueryString. */
function formFields(html, query) {
  const form = (html.match(/<form\b[^>]*\bid="viewInstanceForm"[\s\S]*?<\/form>/i) || [''])[0];
  const fields = [];
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (['submit', 'button', 'image', 'file'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/i.test(tag)) continue;
    fields.push([name, name === 'QueryString' ? query : decode(attr(tag, 'value') ?? '')]);
  }
  for (const m of form.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)) {
    const sel = m[0];
    const name = attr(sel.match(/<select\b[^>]*>/i)[0], 'name');
    if (!name) continue;
    const opt = sel.match(/<option\b[^>]*\sselected\b[^>]*>/i) || sel.match(/<option\b[^>]*>/i);
    if (opt) fields.push([name, decode(attr(opt[0], 'value') ?? '')]);
  }
  return fields;
}

/** Posts the form with one callback (search, page size or page), as the page's own script does. */
async function submit(sess, view, fields, cb) {
  const body = new URLSearchParams();
  for (const [k, v] of fields) body.append(k, v);
  body.append('_VIKEY_', view.vik);
  body.append('_CBNODE_', cb.node);
  body.append('_CBNAME_', cb.name);
  body.append('_CBVALUE_', cb.value ?? '');
  body.append('_CBASYNCUPDATE_', 'true');
  body.append('_CBHTMLFRAGID_', FRAG_ID);
  body.append('_CBHTMLFRAG_', 'true');
  body.append('_CBHTMLFRAGNODEID_', view.container);
  const r = await request(sess, view.action, {
    method: 'POST',
    body: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': view.url,
      'Origin': APP,
      'X-Requested-With': 'XMLHttpRequest',
      'x-catalyst-async': 'true',
      'x-catalyst-secured': 'true',
    },
  });
  checkBlocked(r);
  const flash = r.text.match(/--FJSON:(\{[\s\S]*?\}):--/);
  if (flash) {
    let j = null;
    try { j = JSON.parse(flash[1]); } catch { /* ignore */ }
    if (j && j.hasErrors) throw new Stop('other', 'the register reported an error: ' + flash[1].slice(0, 300), r.url);
  }
  const frag = r.text.match(new RegExp('<!--FB' + FRAG_ID + '-->([\\s\\S]*?)<!--FE' + FRAG_ID + '-->'));
  return { text: frag ? frag[1] : r.text, whole: r.text };
}

function parseRecord(c) {
  const a = c.match(/<a[^>]*class="[^"]*viewMenu[^"]*"[^>]*>[\s\S]*?<span>([^<]*)<\/span>/i);
  if (!a) return null;
  const label = clean(a[1]);
  const field = (cls) => {
    const m = c.match(new RegExp('class="appMinimalAttr ' + cls + '">[\\s\\S]*?class="appMinimalValue"[^>]*>([^<]*)<'));
    return m ? clean(m[1]) : '';
  };
  const values = (cls) => [...c.matchAll(new RegExp('class="appMinimalAttr ' + cls + '"><span class="appMinimalLabel"></span><span class="appMinimalValue">([^<]*)</span>', 'g'))]
    .map((m) => clean(m[1])).filter(Boolean);
  const addr = c.match(/ItemAddress[\s\S]*?<div class="appAttrValue">([^<]*)<\/div>/);
  return {
    name: label.replace(/\s*\([^)]*\)/g, '').trim(),
    fsp_number: (label.match(/\((FSP\d+)\)/) || [])[1] || '',
    nzbn: (label.match(/NZBN:\s*(\d+)/) || [])[1] || '',
    status: field('Status'),
    registration_date: field('RegistrationDate'),
    deregistration_date: field('DeregistrationDate'),
    address: addr ? clean(addr[1]) : '',
    trading_names: values('TradingName'),
    previous_names: values('PreviousName'),
  };
}

function parseResults(html) {
  const banner = html.match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s+results?/i);
  const records = html.split('class="appRecord appBlock appRecordItem').slice(1).map(parseRecord).filter(Boolean);
  return {
    total: banner ? Number(banner[3]) : null,
    records,
    sizeNode: (html.match(/id="node(W\d+)PageSize"/) || [])[1] || null,
    hasResultsBlock: /registerItemSearch-results|appSearchResults/.test(html),
  };
}

function matchRecords(records, keyword) {
  const target = normName(keyword);
  const hits = [];
  for (const rec of records) {
    const cands = [['legal_name', rec.name], ...rec.previous_names.map((v) => ['previous_name', v]),
      ...rec.trading_names.map((v) => ['trading_name', v])];
    const matchedOn = cands.filter(([, v]) => normName(v) === target).map(([k]) => k);
    if (matchedOn.length) hits.push({ ...rec, matched_on: matchedOn });
  }
  return hits;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword ?? '').trim();
  const core = tokens(kw).filter((w) => !LEGAL.has(w)).join(' ').slice(0, 100) || tokens(kw).join(' ').slice(0, 100);
  const checkTime = () => { if (Date.now() - started > DEADLINE_MS) throw new Stop('timeout', 'the lookup ran past 50 s'); };
  try {
    if (!kw || !core) throw new Stop('other', 'empty company name');
    const sess = new Session();

    // 1. Open the search application: sets the session cookies and gives the form.
    const entry = await request(sess, START, {});
    checkBlocked(entry);
    const view = parseView(entry.text, entry.url);
    if (!view) throw new Stop('layout_changed', 'the search form is not as expected: ' + entry.text.slice(0, 200), entry.url);
    const fields = formFields(entry.text, core);

    // 2. Search for the core name ("Contains", the page default).
    checkTime();
    const first = await submit(sess, view, fields, { node: view.searchNode, name: 'buttonPush', value: '' });
    const p1 = parseResults(first.text);
    if (p1.total === null) {
      if (p1.records.length === 0 && /No search results found/i.test(first.text)) {
        return { status: 'not_found', reason: '', records: [], source_url: START, excerpt: `No results for "${core}"` };
      }
      throw new Stop('layout_changed', 'the results block is not as expected: ' + clean(first.text).slice(0, 200));
    }
    const total = p1.total;
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: START, excerpt: `0 results for "${core}"` };
    }

    // 3. Read all the rows: page size 200, then further pages if needed.
    let all = p1.records;
    if (total > all.length && p1.sizeNode) {
      checkTime();
      const sized = await submit(sess, view, fields, { node: p1.sizeNode, name: 'pageSizeChange', value: PAGE_200 });
      const p2 = parseResults(sized.text);
      all = p2.records.length ? p2.records : all;
      const pages = Math.min(Math.ceil(total / 200), MAX_PAGES);
      for (let page = 2; page <= pages && all.length < total; page++) {
        checkTime();
        const pg = await submit(sess, view, fields, { node: p1.sizeNode, name: 'selectPage', value: String(page) });
        const pr = parseResults(pg.text);
        if (!pr.records.length) break;
        all = all.concat(pr.records);
      }
    }

    // 4. Match the company, not just similar words.
    const hits = matchRecords(all, kw);
    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits.map(({ name, fsp_number, nzbn, status, registration_date, deregistration_date, address, trading_names, previous_names, matched_on }) =>
          ({ name, fsp_number, nzbn, status, registration_date, deregistration_date, address, trading_names, previous_names, matched_on })),
        source_url: START,
        excerpt: hits.map((h) => `${h.name} ${h.fsp_number} - ${h.status}`).join(' | ').slice(0, 500),
      };
    }
    if (all.length < total) {
      throw new Stop('other', `results incomplete: read ${all.length} of ${total} rows for "${core}" and none matched`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: START,
      excerpt: `${total} result(s) for "${core}", none matches "${kw}"`,
    };
  } catch (err) {
    if (err instanceof Stop) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.sourceUrl, excerpt: String(err.message).slice(0, 500) };
    }
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: START,
      excerpt: String(err?.message || err).slice(0, 500),
    };
  }
}
