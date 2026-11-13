export const meta = {
  task: 'NZ-is-register.companiesoffice.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'nzbn', 'address', 'incorporation_date', 'type', 'act', 'status'],
  canary: { found: 'HIBISCUS COAST ROTARYSWIMARATHON SOCIETY INCORPORATED', not_found: 'Whakaoranga Rangatahi Kaupapa Tangata Incorporated' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://is-register.companiesoffice.govt.nz';
const LEGAL = new Set(['incorporated', 'inc', 'limited', 'ltd']);
const INLINE = /<\/?(span|b|i|em|strong|a|font|u|small|sup|sub|wbr)\b[^>]*>/gi;

function cc(reason, excerpt, url, status = 'couldnt_check') {
  return { status, reason: status === 'couldnt_check' ? reason : '', records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 500) };
}

// Compare names: accents, case, punctuation, spaces and legal-form words ignored.
function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(t => t && !LEGAL.has(t)).join('');
}

function decode(s) {
  return String(s || '').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function textLines(html) {
  const s = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(INLINE, '').replace(/<[^>]+>/g, '\n');
  return decode(s).split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Session cookies set along the redirect chain are sent back on the next request.
const jar = new Map();
function storeCookies(res) {
  let list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length && res.headers.get('set-cookie')) list = [res.headers.get('set-cookie')];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function hit(url, init = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-NZ,en;q=0.9',
    ...(init.headers || {}),
  };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, {
    method: init.method || 'GET', headers, body: init.body, redirect: 'manual',
    signal: AbortSignal.timeout(25000),
  });
  storeCookies(res);
  return res;
}

// Follow redirects by hand so every hop's cookies are kept.
async function follow(url, init) {
  let current = url;
  for (let hop = 0; hop < 8; hop++) {
    const res = await hit(current, init);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.arrayBuffer().catch(() => {});
      current = new URL(loc, current).href;
      init = undefined;
      continue;
    }
    return { res, url: current };
  }
  throw new Error('too many redirects');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const searchUrl = `${BASE}/search/?category=business-registers&filters[]=registered&filters[]=dissolved&filters[]=externalAdmin&keyword=${encodeURIComponent(name)}`;
  try {
    if (!name) return cc('other', 'empty company name', searchUrl);

    // 1. The register's search form redirects into its search app, which starts a session and shows the search page.
    const view = await follow(searchUrl);
    if (view.res.status === 403 || view.res.status === 429) return cc('blocked', `HTTP ${view.res.status}`, view.url);
    if (view.res.status !== 200) return cc('http_error', `HTTP ${view.res.status}`, view.url);
    const html = await view.res.text();
    if (/Incapsula|incident_id|captcha/i.test(html) && !/viewInstanceForm/.test(html)) return cc('blocked', 'bot check page', view.url);

    const key = (html.match(/viewInstanceKey:'([^']+)'/) || [])[1];
    const formTag = (html.match(/<form[^>]*id="viewInstanceForm"[^>]*>/) || [])[0];
    const action = formTag && (formTag.match(/action="([^"]+)"/) || [])[1];
    if (!key || !action) return cc('layout_changed', html.slice(0, 300), view.url);
    const actionUrl = decode(action);

    // 2. Read the form's fields as the page has them, and the Search button's callback ids.
    const formStart = html.indexOf(formTag);
    const form = html.slice(formStart, html.indexOf('</form>', formStart));
    const fields = new Map();
    for (const m of form.matchAll(/<input[^>]*>/gi)) {
      const t = m[0];
      const fname = (t.match(/name="([^"]*)"/) || [])[1];
      if (!fname) continue;
      const type = ((t.match(/type="([^"]*)"/) || [])[1] || 'text').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && !/checked/i.test(t)) continue;
      if (type === 'submit' || type === 'button' || type === 'reset') continue;
      fields.set(decode(fname), decode((t.match(/value="([^"]*)"/) || [])[1] || ''));
    }
    for (const m of form.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
      const sel = m[2].match(/<option[^>]*selected[^>]*value="([^"]*)"/i) || m[2].match(/<option[^>]*value="([^"]*)"[^>]*selected/i) || m[2].match(/<option[^>]*value="([^"]*)"/i);
      fields.set(decode(m[1]), sel ? decode(sel[1]) : '');
    }
    const searchBtn = (html.match(/<button[^>]*>/gi) || []).find(t => /buttonPad-search[\s"]/.test(t));
    const node = searchBtn && (searchBtn.match(/catHtmlFragmentCallback\('(W\d+)','buttonPush'/) || [])[1];
    const container = searchBtn && (searchBtn.match(/containerNodeId:'(W\d+)'/) || [])[1];
    if (!node || !container) return cc('layout_changed', 'no Search button callback found', view.url);

    fields.set('QueryString', name);
    fields.set('_CBASYNCUPDATE_', 'true');
    fields.set('_CBHTMLFRAGNODEID_', container);
    fields.set('_CBHTMLFRAGID_', '1');
    fields.set('_CBHTMLFRAG_', 'true');
    fields.set('_CBNODE_', node);
    fields.set('_CBNAME_', 'buttonPush');
    fields.set('_VIKEY_', key);

    // 3. Press Search (the same request the page's own button makes).
    const post = await hit(actionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-catalyst-async': 'true', 'x-catalyst-secured': 'true', 'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://app.businessregisters.govt.nz', 'Referer': view.url,
      },
      body: new URLSearchParams(fields).toString(),
    });
    if (post.status === 403 || post.status === 429) return cc('blocked', `HTTP ${post.status}`, view.url);
    if (post.status !== 200) return cc('http_error', `HTTP ${post.status}`, view.url);
    const frag = await post.text();
    if (/unexpected system error/i.test(frag)) return cc('other', 'the register returned a system error', view.url);

    // 4. Read the result rows.
    const parts = frag.split(/results-page-line appReadOnly/).slice(1);
    const rows = parts.map(p => {
      const lines = textLines(p.replace(/^[^>]*>/, ''));
      const ni = lines.findIndex(l => /\(\d{4,10}\)/.test(l));
      const nl = ni >= 0 ? lines[ni] : '';
      const m = nl.match(/^(.*?)\s*\((\d{4,10})\)\s*(?:\(NZBN:\s*(\d{13})\))?/);
      // Labels and values can share one line ("Incorporation Date26-Mar-2019"), so read the text after each label.
      const after = (label) => { const l = lines.find(x => x.startsWith(label)); return l ? l.slice(label.length).trim() : ''; };
      const date = (after('Incorporation Date').match(/\d{1,2}-[A-Za-z]{3}-\d{4}/) || [''])[0];
      return {
        name: m ? m[1].trim() : '',
        registration_number: m ? m[2] : '',
        nzbn: m && m[3] ? m[3] : '',
        address: ni >= 0 ? (lines[ni + 1] || '') : '',
        incorporation_date: date,
        type: after('Type'),
        act: after('Act'),
        status: after('Status'),
        text: lines.slice(0, 12).join(' | '),
      };
    });

    if (rows.length === 0) {
      const fragText = textLines(frag).join(' | ');
      const noRes = fragText.match(/no (matching |search )?(results|records|entities|companies|societies)|0 results|no matches/i);
      if (noRes) {
        const at = noRes.index;
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'no-results text: ' + fragText.slice(Math.max(0, at - 120), at + 120) };
      }
      return cc('layout_changed', 'no result rows and no "no results" text: ' + fragText, view.url);
    }

    const want = normName(name);
    const matches = rows.filter(r => normName(r.name) === want);
    if (matches.length) {
      return {
        status: 'found', reason: '',
        records: matches.map(({ text, ...r }) => r),
        source_url: searchUrl,
        excerpt: matches.map(r => r.text).join(' || ').slice(0, 500),
      };
    }
    if (rows.length >= 10) return cc('other', `the first page is full (${rows.length} rows) and none is this name; the rest is not read`, searchUrl);
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `${rows.length} other result(s), none named ${name}: ${rows.map(r => r.name).join('; ')}`.slice(0, 500) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timeout ? 'timeout' : 'other', String(err?.message || err), searchUrl);
  }
}
