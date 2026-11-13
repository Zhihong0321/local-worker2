export const meta = {
  task: 'TW-yes123.com.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'p_id', 'profile_url', 'industry', 'employees', 'phone', 'address', 'website', 'founded'],
  canary: { found: '神腦國際企業股份有限公司', not_found: '薩維爾虛構科技股份有限公司' },
};

const BASE = 'https://www.yes123.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PROFILES = 3;

// Profile labels as the site writes them (inside <span class="left_title">LABEL：</span>).
const PROFILE_LABELS = {
  industry: '行業類別',
  employees: '員工人數',
  phone: '企業電話',
  address: '企業地址',
  website: '企業網址',
  founded: '成立時間',
};

function decode(s) {
  return (s || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a name: width, case, spaces and punctuation removed. */
function normalize(str) {
  return (str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　.,，。()（）[\]【】\-_/\\·&'"]/g, '');
}

/** Comparable name without the legal form at the end (股份有限公司, 有限公司, 企業社 ...). */
function core(str) {
  return normalize(str).replace(/(股份有限公司|有限公司|股公司|股份有限|企業社|商行|公司)$/, '');
}

function cant(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Reads one company profile page. Never throws; a failed profile keeps the name from the search row. */
async function fetchProfile(pid, name) {
  const url = `${BASE}/wk_index/comp_info.asp?p_id=${encodeURIComponent(pid)}`;
  const rec = { name, p_id: pid, profile_url: url, industry: '', employees: '', phone: '', address: '', website: '', founded: '', profile_status: 'ok' };
  try {
    const r = await get(url);
    if (!r.ok) {
      rec.profile_status = `HTTP ${r.status}`;
      return rec;
    }
    const html = await r.text();
    let found = 0;
    for (const [key, label] of Object.entries(PROFILE_LABELS)) {
      const m = html.match(new RegExp(`left_title">\\s*${label}\\s*[:：]\\s*</span>\\s*<span class="right_main">([\\s\\S]*?)</span`));
      if (m) {
        rec[key] = cleanText(m[1]);
        found++;
      }
    }
    if (found === 0) rec.profile_status = 'layout_changed';
    return rec;
  } catch (err) {
    rec.profile_status = `error: ${String(err?.message || err).slice(0, 120)}`;
    return rec;
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = typeof keyword === 'string' ? keyword.trim() : '';
  const target = core(name);
  if (!target) return cant('other', BASE, 'empty company name');

  // The site has no company-name search: the job search lists postings with their company, and each
  // company's profile is linked from its postings. The search matches company names, so the first page is checked.
  const searchUrl = `${BASE}/wk_index/joblist.asp?sdo=search&find_key1=${encodeURIComponent(name)}`;

  try {
    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429) return cant('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return cant('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const totalMatch = html.match(/共\s*([\d,]+)\s*筆/);
    const titleOk = /找工作查詢/.test(html);

    if (!totalMatch && !titleOk) {
      if (/captcha|cf-chl|Access Denied|驗證碼/i.test(html)) return cant('blocked', searchUrl, html.slice(0, 200));
      return cant('layout_changed', searchUrl, html.slice(0, 200));
    }

    // One desktop job card = one <h6> with the company link and name.
    const rowRe = /<h6><a href="comp_info\.asp\?p_id=([^"'&#]+)[^"]*"[^>]*>([^<]*)<\/a><\/h6>/g;
    const matches = new Map();
    const seenNames = [];
    let rowCount = 0;
    for (const m of html.matchAll(rowRe)) {
      rowCount++;
      const pid = m[1];
      const rowName = cleanText(m[2]);
      if (seenNames.length < 5 && !seenNames.includes(rowName)) seenNames.push(rowName);
      if (core(rowName) === target && !matches.has(pid)) matches.set(pid, rowName);
    }
    const total = totalMatch ? totalMatch[1] : '?';

    if (rowCount === 0) {
      if (totalMatch && /^0$/.test(total.replace(/,/g, ''))) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `共0筆 for "${name}"` };
      }
      return cant('layout_changed', searchUrl, `title ok, ${total} results, no company cards parsed`);
    }

    if (matches.size === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `共${total}筆 job matches for "${name}"; none of the first-page companies is "${name}" (e.g. ${seenNames.join(' / ')})`.slice(0, 300),
      };
    }

    const picks = [...matches.entries()].slice(0, MAX_PROFILES);
    const records = await Promise.all(picks.map(([pid, rowName]) => fetchProfile(pid, rowName)));
    const first = records[0];
    const excerpt = [first.name, first.industry, first.employees, first.address].filter(Boolean).join(' | ');

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: excerpt.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return cant(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
