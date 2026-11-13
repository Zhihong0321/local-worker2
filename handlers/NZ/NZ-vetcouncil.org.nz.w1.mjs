export const meta = {
  task: 'NZ-vetcouncil.org.nz',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'practice_id', 'region', 'address', 'phone', 'profile_url'],
  canary: { found: 'The Small Animal Surgeon Ltd', not_found: 'Te Whare Kararehe Kōrero Ora' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.vetcouncil.org.nz';
const PAGE_URL = BASE + '/Web/Find_a_Pract.aspx';
const SHEET = 'ctl01$TemplateBody$WebPartManager1$gwpciNewQueryMenuCommon$ciNewQueryMenuCommon$ResultsGrid$Sheet0';
const LEGAL = ['limited', 'ltd', 'incorporated', 'inc', 'llc', 'lp', 'pty', 'plc', 'sdn', 'bhd', 'co', 'company', 'corporation', 'corp'];
const MAX_PAGES = 8;        // the pager shows 10 page links, so 8 pages cover up to 80 results
const MAX_PROFILES = 3;     // profile pages read for matched practices
const BUDGET_MS = 40000;    // stop paging well before the 60 s limit

function decode(s) {
  return String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower case, no accents (macrons too), no punctuation: used only to compare names. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The name as typed, with trailing legal-form words removed (case and punctuation kept, for the search box). */
function stripLegal(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL.includes(fold(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

class Jar {
  constructor() { this.map = new Map(); }
  take(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function send(jar, url, init = {}) {
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(init.headers || {}) };
  if (jar.header()) headers.Cookie = jar.header();
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(25000) });
  jar.take(res);
  return res;
}

/** Value of a hidden input (or any input) by its name attribute. */
function field(html, name) {
  const at = html.indexOf(`name="${name}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf('<input', at);
  const end = html.indexOf('>', at);
  const m = html.slice(start, end).match(/\svalue="([^"]*)"/);
  return m ? decode(m[1]) : '';
}

function formState(html) {
  return {
    VS: field(html, '__VIEWSTATE'),
    VSG: field(html, '__VIEWSTATEGENERATOR'),
    EV: field(html, '__EVENTVALIDATION'),
    RVT: field(html, '__RequestVerificationToken'),
    PIK: field(html, 'PageInstanceKey'),
    CT3: field(html, `${SHEET}$ctl03`),
  };
}

function formBody(st, target, searchText, submit) {
  const p = new URLSearchParams();
  p.set('__EVENTTARGET', target || '');
  p.set('__EVENTARGUMENT', '');
  p.set('__VIEWSTATE', st.VS);
  if (st.VSG) p.set('__VIEWSTATEGENERATOR', st.VSG);
  if (st.EV) p.set('__EVENTVALIDATION', st.EV);
  if (st.RVT) p.set('__RequestVerificationToken', st.RVT);
  if (st.PIK) p.set('PageInstanceKey', st.PIK);
  p.set('IsControlPostBack', '1');
  p.set('PageIsDirty', 'false');
  p.set(`${SHEET}$ctl03`, st.CT3);
  p.set(`${SHEET}$Input0$TextBox1`, searchText);
  p.set(`${SHEET}$Input1$DropDown1`, '');
  if (submit) p.set(`${SHEET}$SubmitButton`, 'Find');
  return p.toString();
}

function parseRows(html) {
  const rows = [];
  const re = /<tr class="rg(?:Alt)?Row"[^>]*>\s*<td><a title="([^"]*)" href="([^"]*)">[\s\S]*?<\/a><\/td>\s*<td>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = (m[2].match(/ID=(\d+)/) || [])[1] || '';
    rows.push({ name: decode(m[1]).trim(), href: decode(m[2]), id, region: cleanText(m[3]) });
  }
  return rows;
}

function itemCounts(html) {
  const m = html.match(/<strong>\s*(\d+)\s*<\/strong>\s*items?\s+in\s+<strong>\s*(\d+)\s*<\/strong>\s*pages?/i);
  return m ? { items: Number(m[1]), pages: Number(m[2]) } : null;
}

function pageTarget(html, n) {
  const m = html.match(new RegExp(`title="Go to Page ${n}"[^>]*href="javascript:__doPostBack\\(&#39;([^&]+)&#39;`));
  return m ? decode(m[1]) : null;
}

async function readProfile(jar, href) {
  const res = await send(jar, new URL(href, BASE).href);
  if (!res.ok) return null;
  const html = await res.text();
  const a = html.indexOf('Details of selected practice');
  const b = html.indexOf('Vets associated with this practice');
  if (a < 0 || b <= a) return null;
  const m = html.slice(a, b).match(/<tr class="rg(?:Alt)?Row"[^>]*>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/);
  if (!m) return null;
  return { address: cleanText(m[2]), phone: cleanText(m[3]) };
}

const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt).slice(0, 300) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const searchText = stripLegal(keyword);
    if (!searchText) return fail('other', 'empty company name');
    const wanted = fold(searchText);
    const jar = new Jar();

    const getRes = await send(jar, PAGE_URL);
    if (getRes.status === 403 || getRes.status === 429) return fail('blocked', `HTTP ${getRes.status} on the search page`);
    if (!getRes.ok) return fail('http_error', `HTTP ${getRes.status} on the search page`);
    let html = await getRes.text();
    let st = formState(html);
    if (!st.VS || !st.CT3) return fail('layout_changed', 'practice search form not found on the page');

    const matched = [];
    let total = 0;
    let pages = 0;
    let pageNo = 1;
    let target = '';
    let submit = true;
    for (;;) {
      const res = await send(jar, PAGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': PAGE_URL },
        body: formBody(st, target, searchText, submit),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status} on results page ${pageNo}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status} on results page ${pageNo}`);
      html = await res.text();
      if (/cf-chl|Just a moment\.\.\.|g-recaptcha|h-captcha/i.test(html)) return fail('blocked', 'bot check on results page');
      if (!html.includes('ResultsGrid_Grid1')) return fail('layout_changed', 'no results grid on the page');

      const rows = parseRows(html);
      if (pageNo === 1) {
        // Three shapes: "N items in M pages" (paged), no pager at all (one page of rows), or the explicit empty message.
        let counts = itemCounts(html);
        if (!counts && /There are no records\./.test(html)) counts = { items: 0, pages: 0 };
        if (!counts && !html.includes('rgPager') && rows.length > 0) counts = { items: rows.length, pages: 1 };
        if (!counts) return fail('layout_changed', 'no item count, pager or "There are no records." on the results page');
        total = counts.items;
        pages = counts.pages;
      }
      for (const row of rows) {
        if (fold(stripLegal(row.name)) === wanted) matched.push(row);
      }

      const next = formState(html);
      if (next.VS) st = { ...st, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v)) };
      if (pageNo >= pages) break;                       // every page scanned
      if (pageNo >= MAX_PAGES || Date.now() - started > BUDGET_MS) break;
      target = pageTarget(html, pageNo + 1);
      if (!target) break;
      pageNo++;
      submit = false;
    }
    const complete = pageNo >= pages;

    if (matched.length === 0) {
      if (complete) {
        return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
          excerpt: `${total} practice(s) matched "${searchText}" in ${pages} page(s); none with this name` };
      }
      return fail('timeout', `${total} results in ${pages} pages; checked ${pageNo} pages, no exact name match yet`);
    }

    const records = [];
    for (const row of matched) {
      let extra = null;
      if (records.length < MAX_PROFILES) {
        try { extra = await readProfile(jar, row.href); } catch { extra = null; }
      }
      records.push({
        name: row.name,
        practice_id: row.id,
        region: row.region,
        address: extra ? extra.address : '',
        phone: extra ? extra.phone : '',
        profile_url: new URL(row.href, BASE).href,
      });
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE_URL,
      excerpt: `${records.length} practice(s) with this name among ${total} results for "${searchText}": ${records.map(r => r.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
