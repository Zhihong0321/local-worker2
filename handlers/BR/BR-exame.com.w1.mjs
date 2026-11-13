export const meta = {
  task: 'BR-exame.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'sector', 'rank', 'revenue_current_year', 'revenue_previous_year', 'net_profit', 'net_worth', 'total_assets', 'city', 'uf'],
  canary: { found: 'PETROBRAS', not_found: 'Empresa Fictícia Inexistente Ltda' },
};

// Exame's "As Maiores empresas" page (Melhores e Maiores) embeds its ranking rows as JSON inside the page.
// It covers the 1,000 largest companies by revenue only. A not_found here means "not in that list", not "does not exist".
const PAGE = 'https://exame.com/mm/maiores/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_TOKENS = new Set(['ltda', 'sa', 's', 'a', 'eireli', 'me', 'epp', 'cia']);

/** Lower-case, accents removed, punctuation removed, trailing legal-form words removed. */
function normName(str) {
  const tokens = (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Pull every ranking row ({"company":...}) out of the page's embedded data. */
function parseRows(html) {
  const text = html.replace(/\\"/g, '"');
  const rows = [];
  const seen = new Set();
  for (const m of text.matchAll(/\{"company":[^{}]*\}/g)) {
    let row;
    try { row = JSON.parse(m[0]); } catch { continue; }
    if (typeof row.company !== 'string') continue;
    const key = [row.company, row.sector, row.rank].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|challenge-platform|cf-chl/i.test(html)) return couldnt('blocked', 'bot check page');
    if (!html.includes('rankingTableData') || !html.includes('\\"company\\":')) {
      return couldnt('layout_changed', html.slice(0, 300));
    }

    const rows = parseRows(html);
    if (rows.length < 100) return couldnt('layout_changed', `only ${rows.length} ranking rows found`);

    const want = normName(keyword);
    if (!want) return couldnt('other', 'empty company name');

    const matches = rows.filter((r) => normName(r.company) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `No row named "${keyword}" in the Exame Melhores e Maiores list of ${rows.length} companies (the largest by revenue)`,
      };
    }

    const records = matches.map((r) => ({
      name: r.company,
      sector: r.sector,
      rank: r.rank,
      revenue_current_year: r.revenue_current_year,
      revenue_previous_year: r.revenue_previous_year,
      net_profit: r.net_profit,
      net_worth: r.net_worth,
      total_assets: r.total_assets,
      city: r.city,
      uf: r.uf,
    }));
    const first = matches[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE,
      excerpt: `Exame Melhores e Maiores: ${first.company}, rank ${first.rank} by revenue, sector ${first.sector}, city ${first.city} (${first.uf})`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
