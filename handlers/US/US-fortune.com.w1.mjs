export const meta = { task: 'US-fortune.com', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['name', 'rank', 'year', 'sector', 'industry', 'headquarters_city', 'state', 'revenue_musd', 'profits_musd', 'employees', 'company_url'],
  canary: { found: 'Walmart', not_found: 'Zzyzx Qwerty Nonexistent Holdings LLC' } };

const LIST_URL = 'https://fortune.com/ranking/fortune500/search/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal forms are removed from both sides before comparing, so "ACME, Inc." matches "Acme".
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'lp', 'llp', 'plc']);

function normalise(str) {
  let words = String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words = words.slice(1);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function cleanText(s) {
  return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
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
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      const bot = /captcha|cf-chl|Just a moment|Access denied/i.test(html);
      return { status: 'couldnt_check', reason: bot ? 'blocked' : 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: cleanText(html).slice(0, 300) };
    }

    let items, year;
    try {
      const search = JSON.parse(m[1])?.props?.pageProps?.franchiseSearch;
      items = search?.items;
      year = String(search?.year ?? '');
    } catch (e) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: 'embedded data is not JSON' };
    }
    if (!Array.isArray(items) || items.length < 100 || !items.every((x) => x && typeof x.name === 'string' && x.data)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: `embedded list has an unexpected shape (${Array.isArray(items) ? items.length : 'no list'} entries)` };
    }

    const want = normalise(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'the company name is empty after cleaning' };
    }

    const matches = items.filter((x) => normalise(x.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No match in the Fortune 1000 list on this page (${items.length} companies checked)`,
      };
    }

    const records = matches.map((x) => ({
      name: x.name,
      rank: x.rank,
      year,
      sector: x.data.Sector ?? '',
      industry: x.data.Industry ?? '',
      headquarters_city: x.data['Headquarters City'] ?? '',
      state: x.data.State ?? '',
      revenue_musd: x.data['Revenues ($M)'] ?? '',
      profits_musd: x.data['Profits ($M)'] ?? '',
      employees: x.data.Employees ?? '',
      company_url: x.slug ? new URL(x.slug, 'https://fortune.com').href : '',
    }));

    const first = records[0];
    return {
      status: 'found', reason: '', records, source_url: LIST_URL,
      excerpt: `Fortune 1000 rank #${first.rank}: ${first.name}, ${first.sector}, ${first.headquarters_city}, ${first.state}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
