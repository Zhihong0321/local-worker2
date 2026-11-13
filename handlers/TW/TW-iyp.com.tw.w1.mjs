export const meta = {
  task: 'TW-iyp.com.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'tax_id', 'status', 'business_name', 'address', 'phone', 'company_type', 'detail_url'],
  canary: { found: '協源工具五金行', not_found: '零零零不存在有限公司' },
};

const BASE = 'https://www.iyp.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
};
const TOTAL_BUDGET_MS = 55000;

function cleanText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparable form of a company name: NFKC, lower case, 臺 = 台, punctuation and the legal form at the end removed. */
function normalizeName(s) {
  let t = cleanText(s).normalize('NFKC').toLowerCase().replace(/臺/g, '台');
  t = t.replace(/[\s\-_.,，。·・&'"‘’“”()（）\[\]【】|]/g, '');
  t = t.replace(/(股份有限公司|有限責任公司|有限公司|股份有限|分公司|公司|coltd|companylimited|limited|ltd|inc|corp|llc)$/, '');
  return t;
}

/** Name variants the listing may show: the full title, the title without a trailing (...) note, the part before a - or | tail. */
function titleVariants(title) {
  const full = cleanText(title);
  const noBracket = full.replace(/[（(][^（()）]*[)）]\s*$/, '').trim();
  const beforeSep = full.split(/[-|]/)[0].trim();
  return [full, noBracket, beforeSep];
}

function pick(text, re) {
  const m = text.match(re);
  return m ? cleanText(m[1]) : '';
}

/** Result cards of the keyword search page. */
function parseCards(html) {
  const re = /<a\s+href="([^"]*)"[^>]*?class="line-clamp-1 text-xl font-bold[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const cards = [];
  let m;
  while ((m = re.exec(html))) {
    cards.push({ href: m[1], title: cleanText(m[2]), at: m.index, end: re.lastIndex });
  }
  cards.forEach((c, i) => {
    const stop = i + 1 < cards.length ? cards[i + 1].at : c.end + 3000;
    const seg = html.slice(c.end, Math.min(stop, c.end + 3000));
    c.address = pick(seg, /material-symbols-rounded[^>]*>location_on<\/span>\s*([^<]*?)\s*<\/div>/);
    c.phone = pick(seg, /material-symbols-rounded[^>]*>call<\/span>\s*([^<]*?)\s*<\/div>/);
  });
  return cards;
}

/** Registration block (稅籍登記資料) of a detail page. */
function parseDetail(html) {
  const out = { tax_id: '', status: '', business_name: '', address: '', company_type: '' };
  const i = html.indexOf('稅籍登記資料');
  const tax = i >= 0 ? html.slice(i) : '';
  const labels = { '統一編號': 'tax_id', '狀態': 'status', '營業名稱': 'business_name', '營業地址': 'address', '公司類型': 'company_type' };
  const re = /<li>\s*<strong>([^<]*?)[：:]\s*<\/strong>\s*([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(tax))) {
    const key = labels[cleanText(m[1])];
    if (key && !out[key]) out[key] = cleanText(m[2]);
  }
  return out;
}

function blocked(searchUrl, excerpt) {
  return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const searchUrl = `${BASE}/search?q=${encodeURIComponent(kw)}&type=keywords&city=all`;
  try {
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty keyword' };
    }
    const target = normalizeName(kw);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'keyword has no name left after normalising' };
    }

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) {
      return blocked(searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!/使用關鍵字搜尋「/.test(html)) {
      if (/cf-chl|challenge-platform|g-recaptcha|captcha|請完成驗證/i.test(html)) {
        return blocked(searchUrl, 'bot or captcha page');
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const cards = parseCards(html);
    const matches = cards.filter((c) => titleVariants(c.title).some((v) => normalizeName(v) === target));

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `search returned ${cards.length} listing(s); none is named "${kw}"`,
      };
    }

    // Build one record per distinct listing; enrich from the detail page when the listing has one.
    // Listings with a detail page first, so the duplicate kept for a company is the one that can be enriched.
    const ordered = [...matches].sort((a, b) => Number(/^\/\d{6,}$/.test(b.href)) - Number(/^\/\d{6,}$/.test(a.href)));
    const seen = new Set();
    const records = [];
    for (const c of ordered) {
      const key = `${c.phone}|${c.address}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const rec = {
        name: c.title,
        tax_id: '',
        status: '',
        business_name: '',
        address: c.address,
        phone: c.phone,
        company_type: '',
        detail_url: '',
      };

      if (/^\/\d{6,}$/.test(c.href)) {
        const elapsed = Date.now() - started;
        const left = TOTAL_BUDGET_MS - elapsed;
        if (left > 3000) {
          const detailUrl = BASE + c.href;
          rec.detail_url = detailUrl;
          try {
            const dres = await fetch(detailUrl, { headers: HEADERS, signal: AbortSignal.timeout(Math.min(25000, left)) });
            if (dres.ok) {
              const d = parseDetail(await dres.text());
              for (const k of ['tax_id', 'status', 'business_name', 'company_type']) if (d[k]) rec[k] = d[k];
              if (!rec.address && d.address) rec.address = d.address;
            }
          } catch (e) {
            // Detail page unavailable: keep the listing data from the search page.
          }
        }
      }
      records.push(rec);
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: [first.name, first.address, first.phone, first.tax_id ? `統一編號 ${first.tax_id}` : ''].filter(Boolean).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
