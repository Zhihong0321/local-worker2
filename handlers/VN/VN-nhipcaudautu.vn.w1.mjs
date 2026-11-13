export const meta = {
  task: 'VN-nhipcaudautu.vn',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'rank', 'ticker', 'edition', 'table', 'industry', 'score'],
  canary: { found: 'Công ty Cổ phần FPT', not_found: 'Công ty Cổ phần Doanh Nghiệp Không Tồn Tại Xyz' },
};

const PAGE_URL = 'https://top50.nhipcaudautu.vn/top50.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower case, strip Vietnamese diacritics, keep only a-z0-9 and single spaces. */
function fold(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Core name: folded, with legal-form words removed, so "Công ty Cổ phần FPT" and "FPT" compare equal. */
const LEGAL_FORMS = ['tong cong ty', 'cong ty', 'co phan', 'ctcp', 'cp', 'tnhh', 'jsc', 'tap doan', 'cty', 'ltd', 'llc', 'corp'];
function coreName(str) {
  let t = ` ${fold(str)} `;
  for (const form of LEGAL_FORMS) t = t.split(` ${form} `).join(' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let html;
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    html = await res.text();
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }

  try {
    if (/captcha|recaptcha|cf-chl|Access denied/i.test(html) && !html.includes('b-link')) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: 'bot check page' };
    }

    // Each company row of a ranking table: a <tr> holding rank, flag, ticker, name link and a "+" icon.
    // Hidden detail tables and the other lists on the page carry no rank/ticker and are skipped.
    const tableStarts = [...html.matchAll(/Xếp hạng/g)].map((m) => m.index);
    const anchors = [...html.matchAll(/<a[^>]*class="b-link"[^>]*>([\s\S]*?)<\/a>/g)];
    const rows = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const start = a.index;
      const end = start + a[0].length;
      const nextStart = i + 1 < anchors.length ? anchors[i + 1].index : html.length;

      const trStart = html.lastIndexOf('<tr', start);
      const trEnd = html.indexOf('</tr>', end);
      if (trStart < 0 || trEnd < 0) continue;
      const cells = (html.slice(trStart, trEnd).match(/<td[\s\S]*?<\/td>/g) || []).map(cleanText);
      const rank = cells[0] || '';
      const ticker = cells.slice(1, 4).find((c) => /^[A-Z0-9]{2,6}$/.test(c)) || '';
      if (!/^\d{1,3}$/.test(rank) || !ticker) continue;

      const name = cleanText(a[1]);
      const detail = cleanText(html.slice(end, nextStart));
      const editionM = detail.match(/Tỉ lệ trung bình 3 năm\s*(\d{4}\s*-\s*\d{4})/);
      const industryM = detail.match(/Ngành:\s*(.+?)\s+Điểm:/);
      const scoreM = detail.match(/Điểm:\s*([\d.,]+)/);
      const table = tableStarts.filter((p) => p < start).length;

      rows.push({
        name,
        core: coreName(name),
        rank,
        ticker,
        table,
        edition: editionM ? editionM[1].replace(/\s+/g, ' ') : '',
        industry: industryM ? industryM[1].trim() : '',
        score: scoreM ? scoreM[1] : '',
      });
    }

    // Sanity: the page holds 15 ranking tables of 50 rows. Fewer rows means the layout changed.
    if (!html.includes('Mã CK') || rows.length < 100) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: PAGE_URL,
        excerpt: `only ${rows.length} ranked rows found; ` + cleanText(html).slice(0, 200),
      };
    }

    const wanted = coreName(keyword).replace(/ /g, '');
    const matches = wanted
      ? rows.filter((r) => r.core && r.core.replace(/ /g, '') === wanted)
      : [];

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: `No match for "${keyword}" among ${rows.length} ranked rows on the TOP50 page`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((r) => ({
        name: r.name,
        rank: r.rank,
        ticker: r.ticker,
        edition: r.edition,
        table: String(r.table),
        industry: r.industry,
        score: r.score,
      })),
      source_url: PAGE_URL,
      excerpt: matches.map((r) => `${r.edition} #${r.rank} ${r.name} (${r.ticker})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
