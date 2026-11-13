// Sabah State Government Directory (directory.sabah.gov.my), linked from www.sabah.gov.my -> "Directory".
// Search: GET /search?term=<name>  -> "Search Result" list of <a href="/department/<code>?term=..">NAME</a>,
//         or "No results match your search query".
// Detail: GET /department/<code>   -> "Address : .. Email : .. Fax : .. Telephone : .. Website : .." (org fields only;
//         the staff table on that page is deliberately NOT read).
export const meta = { task: 'MY-sabah.gov.my', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'address', 'email', 'telephone', 'website', 'department_url'],
  canary: { found: 'Sabah Net Sdn Bhd', not_found: 'Syarikat Fiktif Tiada Rekod Sdn Bhd' } };

const BASE = 'https://directory.sabah.gov.my';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL = new Set(['SDN', 'BHD', 'BERHAD', 'SENDIRIAN', 'PLT', 'LLP', 'TERHAD', 'LIMITED', 'LTD']);

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(html) {
  return decode(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Normalised comparison key: no case, punctuation, diacritics or legal-form words.
function core(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-MY,en;q=0.9,ms;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.text();
  return { status: res.status, finalUrl: res.url || url, body };
}

function failure(e) {
  const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: '',
    excerpt: timeout ? 'directory request timed out' : 'directory request failed: ' + String(e && e.message || e).slice(0, 200) };
}

const BLOCK_RE = /just a moment|cf-chl|captcha|attention required|access denied|verify you are human|too many requests/i;

function pick(text, label) {
  const m = new RegExp(label + '\\s*:\\s*(.*?)\\s*(?=(?:Address|Email|Fax|Telephone|Website|Grid List|Head And Senior)\\s*:|Grid List|$)').exec(text);
  return m ? m[1].trim() : '';
}

async function detail(path, name) {
  const url = BASE + path;
  try {
    const r = await get(url);
    if (r.status !== 200) return { name, department_url: url };
    const text = stripTags(r.body);
    return {
      name,
      address: pick(text, 'Address'),
      email: pick(text, 'Email'),
      telephone: pick(text, 'Telephone'),
      website: pick(text, 'Website'),
      department_url: url,
    };
  } catch (e) {
    return { name, department_url: url };
  }
}

export default async function lookup(keyword) {
  const want = core(keyword);
  if (!want) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '',
      excerpt: 'name has no Latin letters or digits after normalising; the directory lists Latin-script names' };
  }
  const url = BASE + '/search?term=' + encodeURIComponent(want);
  try {
    const r = await get(url);
    if (r.status === 403 || r.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'HTTP ' + r.status };
    }
    if (r.status !== 200) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: 'HTTP ' + r.status };
    }
    if (new URL(r.finalUrl).host !== 'directory.sabah.gov.my') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
        excerpt: 'redirected to ' + r.finalUrl.slice(0, 200) };
    }
    const hasResultHeading = r.body.includes('Search Result');
    if (!hasResultHeading && BLOCK_RE.test(r.body)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot or challenge page' };
    }
    if (!hasResultHeading) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
        excerpt: 'no "Search Result" section on the page' };
    }

    const section = r.body.slice(r.body.indexOf('Search Result'));
    const candidates = [];
    const re = /<a\s+href="(\/department\/[^"?#]+)(?:\?[^"]*)?"\s*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(section)) !== null) {
      const name = stripTags(m[2]);
      if (name) candidates.push({ path: m[1], name });
    }

    if (candidates.length === 0) {
      if (/No results match your search query/i.test(r.body)) {
        return { status: 'not_found', reason: '', records: [], source_url: url,
          excerpt: 'Directory search: "No results match your search query"' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
        excerpt: 'search results section has no entries and no "no results" text' };
    }

    const matches = candidates.filter((c) => core(c.name) === want).slice(0, 3);
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: 'Directory search returned ' + candidates.length + ' other entr' + (candidates.length === 1 ? 'y' : 'ies') +
          ' that do not match this name: ' + candidates.slice(0, 5).map((c) => c.name).join('; ').slice(0, 250) };
    }

    const records = await Promise.all(matches.map((c) => detail(c.path, c.name)));
    const first = records[0];
    return {
      status: 'found', reason: '', records, source_url: url,
      excerpt: ('Directory entry: ' + first.name + (first.address ? ' | ' + first.address : '') +
        (first.telephone ? ' | Tel ' + first.telephone : '')).slice(0, 300),
    };
  } catch (e) {
    return failure(e);
  }
}
