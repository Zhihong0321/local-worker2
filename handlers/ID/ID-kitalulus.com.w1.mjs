export const meta = {
  task: 'ID-kitalulus.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'industry', 'company_size', 'address', 'website', 'description'],
  canary: { found: 'Alba Corporation', not_found: 'PT Tidak Terdaftar Sejahtera Nusantara' },
};

const BASE = 'https://www.kitalulus.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id,en;q=0.8',
};
// Indonesian legal-form words: removed when comparing names, because the site shows the trading name.
const LEGAL = new Set(['pt', 'cv', 'tbk', 'persero', 'perseroan', 'terbatas', 'ud', 'firma', 'yayasan', 'sdn', 'bhd', 'pte', 'ltd', 'llc', 'inc']);
const REASON_RANK = ['blocked', 'layout_changed', 'http_error', 'timeout', 'other'];

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case ASCII words: accents removed, '&' read as 'and', punctuation dropped. */
function words(s) {
  return decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Two comparison keys: the full normalised name, and the name without legal-form words. */
function keys(name) {
  const w = words(name);
  return { full: w.join(''), stripped: w.filter((t) => !LEGAL.has(t)).join('') };
}

function letterOf(word) {
  const c = (word || '').charAt(0);
  return /[a-z]/.test(c) ? c.toUpperCase() : '#';
}

/** The site files companies by the first letter of the displayed name ('#' for digits and other symbols). */
function candidateLetters(keyword) {
  const w = words(keyword);
  const stripped = w.filter((t) => !LEGAL.has(t));
  const set = new Set();
  set.add(letterOf(w[0]));
  set.add(letterOf(stripped[0]));
  set.add('P'); // many displayed names keep the "PT" prefix, so "PT" is filed under P whatever the keyword starts with
  if (w.includes('cv')) set.add('C');
  return [...set];
}

async function getPage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    const html = await res.text();
    return { url, status: res.status, html };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { url, status: 0, html: '', error: timeout ? 'timeout' : 'other', detail: String((e && e.message) || e).slice(0, 200) };
  }
}

/** Returns null when the index page is usable, otherwise { reason, excerpt }. */
function classify(p) {
  if (p.error) return { reason: p.error, excerpt: p.detail };
  if (p.status === 403 || p.status === 429) return { reason: 'blocked', excerpt: `HTTP ${p.status}` };
  if (p.status < 200 || p.status >= 300) return { reason: 'http_error', excerpt: `HTTP ${p.status}` };
  const isIndex = /Daftar Perusahaan Huruf/.test(p.html);
  if (!isIndex && /captcha|cf-chl|challenge-platform|Just a moment|Attention Required/i.test(p.html)) {
    return { reason: 'blocked', excerpt: 'bot check page' };
  }
  if (!isIndex) return { reason: 'layout_changed', excerpt: clean(p.html).slice(0, 300) };
  return null;
}

/** Company links on an index page: { path, name } (name = the text the site shows). */
function parseList(html) {
  const out = [];
  const re = /<a [^>]*?href="(\/company\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = clean(m[2]);
    if (name) out.push({ path: m[1], name });
  }
  return out;
}

function parseDetail(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const industry = html.match(/<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/);
  const size = html.match(/Ukuran Perusahaan<\/p><\/div><p[^>]*>([\s\S]*?)<\/p>/);
  const addr = html.match(/>Alamat<\/p><\/div><p[^>]*>([\s\S]*?)<\/p>/);
  const web = html.match(/>Website<\/p>[\s\S]*?<a [^>]*href="([^"]*)"/);
  const desc = html.match(/>Tentang Perusahaan<\/p><p[^>]*>([\s\S]*?)<\/p>/);
  const webUrl = web ? decode(web[1]) : '';
  return {
    name: h1 ? clean(h1[1]) : '',
    industry: industry ? clean(industry[1]) : '',
    company_size: size ? clean(size[1]) : '',
    address: addr ? clean(addr[1]) : '',
    website: /^https?:\/\/[^\s/]+\.[^\s]+$/.test(webUrl) ? webUrl : '',
    description: desc ? clean(desc[1]).slice(0, 500) : '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const k = keys(kw);
    if (!k.full) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    const listUrls = candidateLetters(kw).map((L) => `${BASE}/company?page=${encodeURIComponent(L)}`);
    const pages = await Promise.all(listUrls.map(getPage));

    const matches = [];
    const problems = [];
    const checked = [];
    for (const p of pages) {
      const bad = classify(p);
      if (bad) {
        problems.push({ url: p.url, ...bad });
        continue;
      }
      checked.push(p.url);
      for (const entry of parseList(p.html)) {
        // The site sometimes adds a brand in brackets: "PT X (Brand)". Compare with and without that part.
        const forms = [keys(entry.name), keys(entry.name.replace(/\([^)]*\)/g, ' '))];
        const same = forms.some((r) => (k.full && k.full === r.full) || (k.stripped && k.stripped === r.stripped));
        if (same && !matches.some((m) => m.path === entry.path)) matches.push(entry);
      }
    }

    if (matches.length) {
      // A real match on a listed page is a positive answer even if another index page failed.
      const top = matches.slice(0, 5);
      const details = await Promise.all(top.map((m) => getPage(BASE + m.path)));
      const records = top.map((m, i) => {
        const d = details[i];
        const ok = d && !d.error && d.status >= 200 && d.status < 300 && d.html;
        const x = ok ? parseDetail(d.html) : {};
        return {
          name: x.name || m.name,
          profile_url: BASE + m.path,
          industry: x.industry || '',
          company_size: x.company_size || '',
          address: x.address || '',
          website: x.website || '',
          description: x.description || '',
        };
      });
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].profile_url,
        excerpt: [records[0].name, records[0].industry, records[0].address].filter(Boolean).join(' | ').slice(0, 300),
      };
    }

    if (problems.length) {
      problems.sort((a, b) => REASON_RANK.indexOf(a.reason) - REASON_RANK.indexOf(b.reason));
      const worst = problems[0];
      return { status: 'couldnt_check', reason: worst.reason, records: [], source_url: worst.url, excerpt: String(worst.excerpt || '').slice(0, 300) };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: checked[0],
      excerpt: `No displayed name matched on: ${checked.join(', ')}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
