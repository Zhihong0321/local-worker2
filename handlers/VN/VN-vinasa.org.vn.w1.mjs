export const meta = {
  task: 'VN-vinasa.org.vn',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'region', 'address', 'phone', 'website', 'field'],
  canary: { found: 'Công ty Cổ phần FPT', not_found: 'Công ty TNHH Không Có Thật Việt Nam' },
};

// VINASA publishes its members as three static list pages (Hanoi, Ho Chi Minh City, other provinces).
// Each member is one table row: the name in bold, then "Địa chỉ:", "Điện thoại:", "Website:", "Lĩnh vực:".
const LIST_PAGES = [
  { region: 'Hà Nội', url: 'https://www.vinasa.org.vn/vinasa/4/3074/4281/hoi-vien-ha-noi/' },
  { region: 'Hồ Chí Minh', url: 'https://www.vinasa.org.vn/vinasa/4/3074/4282/hoi-vien-ho-chi-minh/' },
  { region: 'Khu vực khác', url: 'https://www.vinasa.org.vn/vinasa/4/3074/4283/hoi-vien-khu-vuc-khac/' },
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words, removed wherever they occur, so "Công ty Cổ phần FPT" and "FPT" compare equal.
// "chi nhanh" (branch) is deliberately NOT removed: a branch is not the same company record.
const LEGAL_FORMS = [
  ['cong', 'ty', 'co', 'phan'], ['cong', 'ty', 'tnhh'], ['tnhh', 'mtv'], ['mot', 'thanh', 'vien'],
  ['doanh', 'nghiep', 'tu', 'nhan'], ['cong', 'ty'], ['co', 'phan'], ['tnhh'], ['ctcp'], ['cty'], ['dntn'],
  ['mtv'], ['co', 'ltd'], ['company', 'limited'], ['ltd'], ['limited'], ['jsc'], ['llc'], ['cp'],
];

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
}

function flatten(html) {
  return decode((html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Normalised comparison key: no diacritics, lower case, punctuation removed, legal-form words removed.
function coreName(str) {
  let words = (str || '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (const form of LEGAL_FORMS) {
      for (let i = 0; i + form.length <= words.length; i++) {
        if (form.every((w, j) => words[i + j] === w)) {
          words.splice(i, form.length);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return words.join(' ');
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// Parse one list page into member entries. One entry per table row that carries an address line.
function parseEntries(html, page) {
  const entries = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const at = row.search(/Địa chỉ/);
    if (at < 0) continue;
    const tdStart = row.slice(0, at).lastIndexOf('<td');
    const name = flatten(row.slice(0, at).slice(tdStart >= 0 ? tdStart : 0));
    if (!name) continue;
    const text = flatten(row.slice(tdStart >= 0 ? tdStart : 0));
    entries.push({
      name,
      region: page.region,
      source_url: page.url,
      address: firstMatch(text, /Địa chỉ\s*:\s*(.+?)(?=\s*(?:Điện thoại|Dien thoai|Website|Email|Lĩnh vực|$))/),
      phone: firstMatch(text, /Điện thoại\s*:\s*([^*]+?)\s*(?:\*|Email|Website|Lĩnh vực|$)/),
      website: firstMatch(text, /Website\s*:\s*(\S+)/),
      field: firstMatch(text, /Lĩnh vực\s*:\s*(.+)$/),
      excerpt: text.slice(0, 300),
    });
  }
  return entries;
}

async function fetchPage(page) {
  let res;
  try {
    res = await fetch(page.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { page, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) {
    return { page, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { page, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  }
  const html = await res.text();
  if (/cdn-cgi\/challenge-platform|cf-browser-verification|g-recaptcha|hcaptcha/i.test(html)) {
    return { page, reason: 'blocked', excerpt: 'bot check page' };
  }
  const entries = parseEntries(html, page);
  if (!html.includes('Hội viên') || entries.length === 0) {
    return { page, reason: 'layout_changed', excerpt: flatten(html).slice(0, 300) };
  }
  return { page, entries };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = coreName(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_PAGES[0].url, excerpt: 'empty company name' };
    }

    const results = await Promise.all(LIST_PAGES.map(fetchPage));
    const failures = results.filter((r) => r.reason);
    const checkedCount = results.reduce((n, r) => n + (r.entries ? r.entries.length : 0), 0);

    const seen = new Set();
    const records = [];
    let matchedExcerpt = '';
    for (const r of results) {
      for (const e of r.entries || []) {
        if (coreName(e.name) !== key) continue;
        const id = `${e.region}|${e.name}|${e.address}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!matchedExcerpt) matchedExcerpt = e.excerpt;
        const { excerpt, ...record } = e;
        records.push(record);
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].source_url,
        excerpt: matchedExcerpt,
      };
    }

    if (failures.length > 0) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      const worst = failures.slice().sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
      return {
        status: 'couldnt_check',
        reason: worst.reason,
        records: [],
        source_url: worst.page.url,
        excerpt: worst.excerpt,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_PAGES.map((p) => p.url).join(' | '),
      excerpt: `Checked ${checkedCount} member entries on ${LIST_PAGES.length} VINASA member list pages; no exact match`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LIST_PAGES[0].url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
