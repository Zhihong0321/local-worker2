export const meta = {
  task: 'VN-hnx.vn',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['code', 'name', 'market', 'address', 'phone', 'licence', 'industry', 'legal_representative',
    'disclosure_officer', 'control_status', 'trading_status', 'first_trading_date',
    'charter_capital_thousand_vnd', 'listed_shares'],
  canary: { found: 'Công ty Cổ phần chứng khoán Sài Gòn - Hà Nội', not_found: 'Công ty Cổ phần Đầu tư Mặt Trăng Xanh Việt Nam' },
};

const BASE = 'https://hnx.vn/vi-vn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'vi,en;q=0.8',
};

// Two market lists. Each stock-detail page carries the full symbol list of its market in <select id="cboSymboOnDetail">.
const SOURCES = [
  { code: 'ny', market: 'listed (HNX)', listPath: '/cophieu-etfs/chi-tiet-chung-khoan-ny-shs.html' },
  { code: 'uc', market: 'UPCoM', listPath: '/cophieu-etfs/chi-tiet-chung-khoan-uc-abb.html' },
];

// Legal-form words, removed only when comparing names. Longest first.
const LEGAL_PHRASES = ['tong cong ty', 'cong ty co phan', 'cong ty cp', 'cong ty tnhh', 'cong ty',
  'joint stock company', 'limited liability company', 'co ltd', 'ltd', 'jsc', 'ctcp', 'tnhh', 'cp', 'corp', 'inc'];

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare form of a company name: no case, no Vietnamese marks, no punctuation, no legal-form words. */
function normalizeName(s) {
  let t = decodeEntities(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  for (const p of LEGAL_PHRASES) {
    t = t.replace(new RegExp('\\b' + p + '\\b', 'g'), ' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Symbol list of one market page: [{ code, label }], or null when the list is not on the page. */
function listOptions(html) {
  const sel = html.match(/<select[^>]*id="cboSymboOnDetail"[\s\S]*?<\/select>/i);
  if (!sel) return null;
  const out = [];
  for (const m of sel[0].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    const code = decodeEntities(m[1]).trim();
    if (code) out.push({ code, label: cleanText(m[2]) });
  }
  return out;
}

/** The company part of a list label, e.g. "SHS - Công ty ..." -> "Công ty ...". */
function companyPart(opt) {
  return opt.label.startsWith(opt.code) ? opt.label.slice(opt.code.length).replace(/^\s*-\s*/, '').trim() : opt.label;
}

/** Bond codes look like MSN123008. They are listed but have no stock detail page. */
function isBondCode(code) {
  return /^[A-Z]{2,4}\d{6}$/.test(code);
}

/** Label -> value pairs from a stock detail page (each value sits in the cell after its label). */
function detailFields(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<select[\s\S]*?<\/select>/gi, ' ')
    .replace(/<[^>]+>/g, '|');
  const cells = decodeEntities(text).split('|').map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const get = (label) => {
    const i = cells.indexOf(label);
    return i >= 0 && i + 1 < cells.length ? cells[i + 1] : '';
  };
  return {
    code: get('Mã CK'),
    name: get('Tên TCPH'),
    address: get('Trụ sở chính'),
    phone: get('Số điện thoại'),
    licence: get('GPTL/ĐKKD'),
    industry: get('Tên ngành'),
    legal_representative: get('Người đại diện pháp luật'),
    disclosure_officer: get('Người công bố thông tin'),
    control_status: get('Trạng thái kiểm soát'),
    trading_status: get('Trạng thái giao dịch'),
    first_trading_date: get('Ngày GD đầu tiên'),
    charter_capital_thousand_vnd: get('Vốn điều lệ (Nghìn đồng)'),
    listed_shares: get('KLLH (Cổ phiếu)'),
  };
}

/** GET one page. Never throws. */
async function getPage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000), redirect: 'follow' });
    if (res.status === 403 || res.status === 429) {
      return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}`, url };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}`, url };
    }
    const html = await res.text();
    if (/captcha|access denied|are you a robot/i.test(html.slice(0, 5000))) {
      return { ok: false, reason: 'blocked', excerpt: 'bot check page', url };
    }
    return { ok: true, html, url: res.url || url };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200), url };
  }
}

async function loadList(src) {
  const url = `${BASE}${src.listPath}`;
  const page = await getPage(url);
  if (!page.ok) return { src, ok: false, reason: page.reason, excerpt: page.excerpt, url };
  const options = listOptions(page.html);
  if (!options || options.length < 50) {
    return { src, ok: false, reason: 'layout_changed', excerpt: 'no symbol list on the page', url };
  }
  return { src, ok: true, options, url };
}

async function recordFor(match) {
  const base = {
    code: match.code,
    name: companyPart(match),
    market: match.src.market,
    source_url: `${BASE}${match.src.listPath}`,
  };
  if (isBondCode(match.code)) {
    return { ...base, type: 'bond', detail: 'list only' };
  }
  const url = `${BASE}/cophieu-etfs/chi-tiet-chung-khoan-${match.src.code}-${match.code.toLowerCase()}.html`;
  const page = await getPage(url);
  if (!page.ok) {
    return { ...base, type: 'stock', source_url: url, detail: page.reason, detail_excerpt: page.excerpt };
  }
  const f = detailFields(page.html);
  if (!f.name) {
    return { ...base, type: 'stock', source_url: url, detail: 'layout_changed', detail_excerpt: 'no company name on the page' };
  }
  return { ...base, ...f, name: f.name, type: 'stock', source_url: url, detail: 'ok' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = normalizeName(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no usable company name' };
    }

    const lists = await Promise.all(SOURCES.map(loadList));

    const matches = [];
    for (const l of lists) {
      if (!l.ok) continue;
      for (const opt of l.options) {
        if (normalizeName(companyPart(opt)) === wanted) matches.push({ ...opt, src: l.src });
      }
    }

    if (matches.length === 0) {
      const failed = lists.filter((l) => !l.ok);
      // A list that could not be read might hold the company, so absence is not proven.
      if (failed.length) {
        const f = failed[0];
        return {
          status: 'couldnt_check',
          reason: f.reason,
          records: [],
          source_url: f.url,
          excerpt: failed.map((x) => `${x.src.market}: ${x.reason} (${x.excerpt})`).join('; '),
        };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: lists[0].url,
        excerpt: `no match in ${lists.map((l) => l.src.market).join(' or ')} lists`,
      };
    }

    const records = await Promise.all(matches.map(recordFor));
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.source_url,
      excerpt: matches.map((m) => m.label).join(' | ').slice(0, 500),
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
