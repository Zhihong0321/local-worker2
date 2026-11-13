export const meta = { task: 'US-nrf.com', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['rank', 'name', 'headquarters', 'usa_retail_sales_2025_billions', 'us_sales_growth_2025_vs_2024', 'usa_pct_of_worldwide_sales', 'notes', 'list'],
  canary: { found: 'Walmart', not_found: 'Zorbex Trading Co' } };

const LIST_URL = 'https://nrf.com/research-insights/top-retailers/top-100-retailers/top-100-retailers-2026-list';
const LIST_NAME = 'NRF Top 100 Retailers 2026';
const MIN_ROWS = 90; // the list has 100 rows; fewer than this means the page is not the list we expect
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words dropped from the end of a name before comparing.
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies', 'ltd', 'limited', 'llc', 'plc', 'lp', 'llp']);

function normalizeName(s) {
  let words = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  if (words[0] === 'the') words.shift();
  while (words.length && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function cleanText(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// One <ul class="...TopListRank_row..."> per company; each row has 7 <li>: rank, name, then 5 "Label: value" items.
function parseRows(html) {
  const rows = html.match(/<ul class="[^"]*TopListRank_row[^"]*"[\s\S]*?<\/ul>/g) || [];
  const out = [];
  for (const row of rows) {
    const cells = (row.match(/<li[^>]*>[\s\S]*?<\/li>/g) || []).map((li) => ({
      labelled: /TopListRank_label/.test(li),
      text: cleanText(li),
    }));
    const plain = cells.filter((c) => !c.labelled).map((c) => c.text);
    const rec = { rank: parseInt(plain[0], 10), name: plain[1] || '', headquarters: '', usa_retail_sales_2025_billions: '',
      us_sales_growth_2025_vs_2024: '', usa_pct_of_worldwide_sales: '', notes: '', list: LIST_NAME };
    for (const c of cells.filter((c) => c.labelled)) {
      const i = c.text.indexOf(':');
      const label = i >= 0 ? c.text.slice(0, i) : '';
      const value = i >= 0 ? c.text.slice(i + 1).trim() : c.text;
      if (/headquarters/i.test(label)) rec.headquarters = value;
      else if (/retail sales/i.test(label)) rec.usa_retail_sales_2025_billions = value;
      else if (/growth/i.test(label)) rec.us_sales_growth_2025_vs_2024 = value;
      else if (/worldwide/i.test(label)) rec.usa_pct_of_worldwide_sales = value;
      else if (/^notes/i.test(label)) rec.notes = value;
    }
    if (Number.isFinite(rec.rank) && rec.name) out.push(rec);
  }
  return out;
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    const rows = parseRows(html);
    if (rows.length < MIN_ROWS) {
      if (/captcha|access denied|unusual traffic|are you a robot/i.test(html)) return fail('blocked', 'bot check page');
      return fail('layout_changed', `found ${rows.length} list rows, expected 100`);
    }
    if (!/<title>[^<]*Top 100 Retailers/i.test(html)) return fail('layout_changed', 'page title is not the Top 100 Retailers list');

    const key = normalizeName(keyword);
    if (!key) return fail('other', 'empty company name');

    const matches = rows.filter((r) => normalizeName(r.name) === key);
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `Not on the ${LIST_NAME} list (${rows.length} companies on the list)` };
    }
    return {
      status: 'found', reason: '', records: matches, source_url: LIST_URL,
      excerpt: matches.map((r) => `#${r.rank} ${r.name} | ${r.headquarters} | 2025 USA retail sales (billions) ${r.usa_retail_sales_2025_billions}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
