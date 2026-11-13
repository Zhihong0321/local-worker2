export const meta = {
  task: 'TW-roccoc.org.tw',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'award', 'year', 'source_page'],
  canary: { found: '大訊科技股份有限公司', not_found: '不存在測試股份有限公司' },
};

// The only company-level list the site publishes: the winners of the 第80屆 金商獎 (2026).
const LIST_URL = 'https://www.roccoc.org.tw/web/choose/choose.jsp?cp_no=CP1727660620016';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const AWARD = '第80屆金商獎';

// Legal-form words removed from the end of a name before comparing (already lower-case, no punctuation).
const LEGAL_FORMS = ['股份有限公司', '有限責任公司', '有限公司', '股份有限', '公司', 'coltd', 'incorporated', 'limited', 'inc', 'corporation', 'corp', 'ltd', 'co'];

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised comparison key: case, width, punctuation, Taiwan 臺/台 spelling and legal form removed. */
function norm(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase().replace(/臺/g, '台').replace(/[\s\p{P}\p{S}]+/gu, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_FORMS) {
      if (t.length > suf.length && t.endsWith(suf)) {
        t = t.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return t;
}

/** Reads the winner names and their category headings from the list page, in page order. */
function parseWinners(html) {
  const out = [];
  let category = '';
  for (const m of html.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)) {
    const text = cleanText(m[1]);
    if (!text) continue;
    // Headings look like "-優良商人" or "第80屆金商獎獲獎-優良外國駐臺商務單位".
    const heading = text.match(/獲獎\s*[-－]\s*(.+)$/) || text.match(/^[-－]\s*(.+)$/);
    if (heading) {
      category = heading[1].trim();
      continue;
    }
    if (category) out.push({ name: text, category });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = norm(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|Attention Required|Access Denied/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'bot or access check page' };
    }

    const winners = parseWinners(html);
    if (!html.includes(AWARD) || winners.length < 20) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: LIST_URL,
        excerpt: cleanText(html).slice(0, 300),
      };
    }

    const matches = winners.filter((w) => norm(w.name) === key);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No match for "${keyword}" in the ${AWARD} winners list (${winners.length} names; the only company list on this site)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((w) => ({
        name: w.name,
        category: w.category,
        award: AWARD,
        year: '2026',
        source_page: LIST_URL,
      })),
      source_url: LIST_URL,
      excerpt: matches.map((w) => `${w.name} (${AWARD} ${w.category})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
