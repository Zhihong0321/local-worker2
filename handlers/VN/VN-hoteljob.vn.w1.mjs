export const meta = {
  task: 'VN-hoteljob.vn',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'location'],
  canary: { found: 'CÔNG TY TNHH AMANAKI', not_found: 'Công ty TNHH Xyzzy Quux Bất Tồn' },
};

const BASE = 'https://www.hoteljob.vn';
const SEARCH_PATH = '/nha-tuyen-dung-vip';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 4;
const MAX_PROFILES = 3;
// Legal-form words removed before comparing names (longest first). Text is already lower-case, ASCII, spaces only.
const LEGAL = [
  'cong ty trach nhiem huu han', 'cong ty co phan', 'cong ty tnhh', 'cong ty', 'mot thanh vien', 'tnhh', 'ctcp',
  'cty', 'mtv', 'co ltd', 'company limited', 'limited', 'ltd', 'jsc', 'corporation', 'company', 'doanh nghiep tu nhan',
];

function norm(s) {
  let t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd');
  t = t.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  let padded = ' ' + t + ' ';
  for (let pass = 0; pass < 2; pass++) {
    for (const p of LEGAL) padded = padded.split(' ' + p + ' ').join(' ');
  }
  return padded.replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function searchUrl(keyword, page) {
  const q = `keyword=${encodeURIComponent(keyword)}`;
  return `${BASE}${SEARCH_PATH}?${q}${page > 1 ? `&page=${page}` : ''}`;
}

/** Same company = same normalised name, either the whole listing title or the part before " - " (e.g. "Hotel & Resorts - Group"). */
function sameCompany(keyword, siteName) {
  const k = norm(keyword);
  if (!k) return false;
  if (norm(siteName) === k) return true;
  const head = String(siteName).split(/\s+-\s+/)[0];
  return norm(head) === k;
}

function parseListings(html) {
  const out = [];
  const seen = new Set();
  const re = /<h3[^>]*>\s*<a[^>]*href="(\/gian-tuyen-dung\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ path: m[1], name: decode(m[2]) });
  }
  return out;
}

function maxPage(html) {
  let max = 1;
  const re = /[?&]page=(\d+)/g;
  let m;
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]));
  return max;
}

/** Throws { reason, excerpt, source_url } on any failure. */
async function fetchText(url) {
  let res;
  let text;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'vi,en;q=0.8', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) throw { reason: 'blocked', excerpt: `HTTP ${res.status}`, source_url: url };
    if (!res.ok) throw { reason: 'http_error', excerpt: `HTTP ${res.status}`, source_url: url };
    text = await res.text();
  } catch (e) {
    if (e && e.reason) throw e;
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw { reason: timedOut ? 'timeout' : 'other', excerpt: String((e && e.message) || e).slice(0, 300), source_url: url };
  }
  if (/\/login|\/dang-nhap/i.test(res.url || '') || /<title>[^<]*(just a moment|attention required|captcha|xác minh)/i.test(text)) {
    throw { reason: 'blocked', excerpt: 'login or bot-check page', source_url: url };
  }
  return { text, url };
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const firstUrl = searchUrl(name, 1);
  try {
    if (!norm(name)) return fail('other', firstUrl, 'keyword has no company name after removing the legal form');

    const first = await fetchText(firstUrl);
    const noResults = /Không có[^<]{0,40}phù hợp/i.test(first.text);
    let listings = parseListings(first.text);
    if (listings.length === 0 && !noResults) {
      return fail('layout_changed', firstUrl, first.text.slice(0, 300));
    }

    const totalPages = maxPage(first.text);
    let scanned = 1;
    let lastUrl = firstUrl;
    let matches = listings.filter((l) => sameCompany(name, l.name));

    // More pages only while there is time left (the whole call must finish in under 60 s).
    while (matches.length === 0 && listings.length > 0 && scanned < totalPages && scanned < MAX_PAGES && Date.now() - started < 20000) {
      scanned += 1;
      lastUrl = searchUrl(name, scanned);
      const page = await fetchText(lastUrl);
      listings = parseListings(page.text);
      matches = listings.filter((l) => sameCompany(name, l.name));
    }

    if (matches.length === 0) {
      if (listings.length > 0 && scanned < totalPages) {
        return fail('other', lastUrl, `no listing with this name on pages 1-${scanned} of ${totalPages}; later pages not checked`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: noResults ? 'Không có kết quả phù hợp (0 results)' : `${listings.length} results on the site, none with this name`,
      };
    }

    // Open the matched profiles for the address (optional; a failure keeps the listing fields).
    const records = [];
    for (const m of matches.slice(0, MAX_PROFILES)) {
      const url = BASE + m.path;
      let location = '';
      if (Date.now() - started < 25000) {
        try {
          const prof = await fetchText(url);
          const a = prof.text.match(/ntd-diachi\.svg[^>]*>\s*([^<]+?)\s*<\/li>/i);
          location = a ? decode(a[1]) : '';
        } catch (e) {
          location = '';
        }
      }
      records.push({ name: m.name, url, location });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: `${matches.length} listing(s) on the site with this name: ${matches.map((m) => m.name).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    if (err && err.reason) return fail(err.reason, err.source_url || firstUrl, err.excerpt);
    return fail('other', firstUrl, String((err && err.message) || err));
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the last sockets finish closing before the runner exits (on Windows an immediate process.exit can abort).
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}
