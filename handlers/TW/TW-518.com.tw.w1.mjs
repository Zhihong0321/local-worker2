export const meta = {
  task: 'TW-518.com.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_url', 'listings_on_page', 'employees', 'industry', 'address', 'website', 'phone', 'capital', 'site_job_count'],
  canary: { found: 'COUPANG 酷澎集團_火箭物流倉儲股份有限公司', not_found: '牛頭馬面測試股份有限公司' },
};

const BASE = 'https://www.518.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;
const BUDGET_MS = 50000; // stay well inside the 60 s limit for the whole call

// Legal-form words, longest first. Only removed from the END of a normalised name.
const LEGAL_SUFFIXES = [
  'sdnbhd', 'pteltd', 'incorporated', 'corporation', 'company', 'limited', 'coltd', 'llc', 'corp', 'inc', 'ltd', 'bhd',
  '股份有限公司', '有限公司', '股份有限', '企業社', '公司',
];

/** Lower case, full-width folded, only letters and digits (punctuation, spaces and underscores dropped). */
function clean(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Normalised name without its trailing legal form, so "X Co., Ltd." and "X" compare equal. */
function coreName(s) {
  let n = clean(s);
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (n.length > suffix.length + 1 && n.endsWith(suffix)) {
        n = n.slice(0, -suffix.length);
        stripped = true;
        break;
      }
    }
  }
  return n;
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

function toText(html) {
  return decode(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

/** Job listings on a search page: each carries a link to the employer's company page and the employer name. */
function parseListings(html) {
  const items = [];
  const re = /<a[^>]*?href="(https?:\/\/www\.518\.com\.tw\/company-[A-Za-z0-9]+\.html)"[^>]*?class="job__comp"[^>]*>\s*<span class="job__comp__name">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push({ url: m[1], name: decode(m[2].replace(/<[^>]+>/g, ' ')) });
  }
  return items;
}

/** Company profile page: the "公司資料" block as label / value pairs. Missing labels come back as ''. */
function companyDetails(html) {
  const t = toText(html);
  const grab = (label) => {
    const m = t.match(new RegExp(label + '\\s*(\\S+)'));
    return m ? m[1] : '';
  };
  const addr = t.match(/聯絡地址\s*(.+?)\s*地圖/);
  return {
    employees: grab('員工人數'),
    industry: grab('產業類別'),
    capital: grab('資\\s*本\\s*額'),
    phone: grab('公司電話'),
    website: grab('公司網址'),
    address: addr ? addr[1] : '',
    site_job_count: grab('職缺列表'),
  };
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getPage(url, deadline) {
  const left = deadline - Date.now();
  if (left < 1000) {
    const e = new Error('time budget used up');
    e.name = 'BudgetError';
    throw e;
  }
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-TW,zh;q=0.9,en;q=0.6',
    },
    signal: AbortSignal.timeout(Math.min(25000, left)),
  });
  const html = res.ok ? await res.text() : '';
  return { status: res.status, ok: res.ok, url: res.url || url, html };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + BUDGET_MS;
  const core = coreName(keyword);
  // The site's search works on the name without spaces or legal form; a query with spaces and "股份有限公司" returns noise.
  const searchUrl = (page) => `${BASE}/job-index-P-${page}.html?ad=${encodeURIComponent(core)}`;
  const firstUrl = core ? searchUrl(1) : BASE;
  try {
    if (!core) return fail('other', BASE, 'empty company name');

    let match = null;
    let matchPage = 0;
    let matchCount = 0;
    let jobsSeen = 0;
    let morePages = false;
    const near = new Map();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = searchUrl(page);
      const res = await getPage(url, deadline);
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);
      if (/member-login|mobile-verify/i.test(res.url)) return fail('blocked', url, `redirected to ${res.url}`);
      if (/captcha|cf-chl|challenge-platform/i.test(res.html)) return fail('blocked', url, 'bot check page');

      const items = parseListings(res.html);
      const emptyMessage = res.html.includes('抱歉沒有搜到適合的職缺');
      if (!items.length) {
        if (page === 1 && !emptyMessage) return fail('layout_changed', url, toText(res.html).slice(0, 300));
        break;
      }
      jobsSeen += items.length;

      const hits = items.filter((it) => coreName(it.name) === core);
      if (hits.length) {
        match = hits[0];
        matchCount = hits.length;
        matchPage = page;
        break;
      }
      for (const it of items) {
        if (coreName(it.name).includes(core)) near.set(it.url, it.name);
      }
      if (!res.html.includes(`job-index-P-${page + 1}.html`)) break;
      if (page === MAX_PAGES) morePages = true;
    }

    if (match) {
      let details = {};
      let detailNote = '';
      try {
        const profile = await getPage(match.url, deadline);
        if (profile.ok && !/captcha|cf-chl/i.test(profile.html)) details = companyDetails(profile.html);
        else detailNote = `company page HTTP ${profile.status}`;
      } catch (e) {
        detailNote = `company page not read: ${e && e.name}`;
      }
      const record = {
        name: match.name,
        company_url: match.url,
        listings_on_page: matchCount,
        search_page: matchPage,
        employees: details.employees || '',
        industry: details.industry || '',
        address: details.address || '',
        website: details.website || '',
        phone: details.phone || '',
        capital: details.capital || '',
        site_job_count: details.site_job_count || '',
        detail_note: detailNote,
      };
      const parts = [
        `${match.name}: listed on 518熊班 with ${matchCount} job listing(s) on search page ${matchPage}`,
        details.employees ? `員工人數 ${details.employees}` : '',
        details.industry ? `產業類別 ${details.industry}` : '',
        details.address ? `聯絡地址 ${details.address}` : '',
      ].filter(Boolean);
      return { status: 'found', reason: '', records: [record], source_url: match.url, excerpt: parts.join(' | ').slice(0, 500) };
    }

    if (morePages) {
      return fail('other', firstUrl, `no exact name match on the first ${MAX_PAGES} result pages, and more pages exist; not checked further`);
    }
    if (near.size) {
      return fail('other', firstUrl, 'no exact name match; similar listed names (check manually): ' + [...near.values()].slice(0, 5).join(' | '));
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: jobsSeen
        ? `no listed company matches "${keyword}"; the search returned ${jobsSeen} listings from other companies`
        : `抱歉沒有搜到適合的職缺 (no matching jobs for "${keyword}")`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' || name === 'BudgetError' ? 'timeout' : 'other';
    return fail(reason, firstUrl, String((err && err.message) || err));
  }
}
