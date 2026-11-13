export const meta = {
  task: 'JP-caa.go.jp',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'title', 'date', 'category', 'notice_url', 'list_url'],
  canary: { found: '株式会社giobai', not_found: '株式会社存在しない商事' },
};

// Consumer Affairs Agency "執行状況" (enforcement notices) — one plain HTML list page per fiscal year.
// Each list item carries the notice title, which names the company (the title is the only place the name is).
const BASE = 'https://www.caa.go.jp/notice/enforcement/';
const FIRST_YEAR = 2021; // the site has no list pages before 2021 (2018–2020 return a "not found" page)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** Comparable form of a company name: full-width → half-width, lower case, legal form and punctuation removed. */
function core(name) {
  const t = String(name || '')
    .replace(/\(株\)|（株）|㈱/g, '株式会社')
    .replace(/\(有\)|（有）|㈲/g, '有限会社')
    .replace(/\(同\)|（同）/g, '合同会社')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\bco\.?\s*,?\s*ltd\.?|\bltd\.?|\binc\.?|\bcorp(oration)?\.?|\bllc\b|\bcompany\b/g, '')
    .replace(/株式会社|有限会社|合同会社|合名会社|合資会社|相互会社/g, '');
  return t.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** The company names a notice title names: the text before "に対する", inside 【】 if present, split on 、 and 及び. */
function namesInTitle(title) {
  let subject = title.replace(/に対する[\s\S]*$/, '').replace(/について$/, '');
  const bracket = subject.match(/【([\s\S]*?)】/);
  if (bracket) subject = bracket[1];
  return subject
    .split(/、|及び/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One list page → its items. Returns null when the page is not the list we expect. */
function parseItems(html) {
  if (!html.includes('news_list')) return null;
  const items = [];
  for (const chunk of html.split('<li>').slice(1)) {
    const a = chunk.match(/<a href="(\/notice\/entry\/[^"]+)" title="([^"]*)"/);
    if (!a) continue;
    const time = chunk.match(/<time datetime="([^"]+)"/);
    const cat = chunk.match(/<span class="category_[^"]*">([^<]*)<\/span>/);
    items.push({
      href: a[1],
      title: decode(a[2]).trim(),
      date: time ? time[1] : '',
      category: cat ? cat[1].trim() : '',
    });
  }
  return items.length ? items : null;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { url, error: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { url, error: 'http_error', excerpt: `HTTP ${res.status}` };
    return { url, html: await res.text() };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, error: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = core(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'the name is empty once the legal form is removed' };
    }

    const lastYear = new Date().getUTCFullYear();
    const urls = [];
    for (let y = FIRST_YEAR; y <= lastYear; y++) urls.push(`${BASE}${y}/`);

    const pages = await Promise.all(urls.map(fetchPage));

    const records = [];
    const failures = [];
    for (const page of pages) {
      if (page.error) { failures.push(page); continue; }
      const items = parseItems(page.html);
      if (!items) {
        failures.push({ url: page.url, error: 'layout_changed', excerpt: page.html.slice(0, 200) });
        continue;
      }
      for (const item of items) {
        const names = namesInTitle(item.title);
        const hit = names.find((n) => core(n) === want);
        if (hit) {
          records.push({
            name: hit,
            title: item.title,
            date: item.date,
            category: item.category,
            notice_url: new URL(item.href, 'https://www.caa.go.jp').href,
            list_url: page.url,
          });
        }
      }
    }

    if (records.length) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: first.list_url,
        excerpt: `${first.date} ${first.category}: ${first.title}`.slice(0, 500),
      };
    }

    // No match. Only a clean answer from every list page counts as not_found; a page we could not read is never "not listed".
    if (failures.length) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      failures.sort((a, b) => order.indexOf(a.error) - order.indexOf(b.error));
      const f = failures[0];
      return {
        status: 'couldnt_check',
        reason: f.error,
        records: [],
        source_url: f.url,
        excerpt: `${failures.length} of ${urls.length} enforcement list pages could not be read; ${f.excerpt || ''}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: BASE,
      excerpt: `No entry naming "${String(keyword).trim()}" in the ${urls.length} enforcement list pages ${FIRST_YEAR}–${lastYear}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
