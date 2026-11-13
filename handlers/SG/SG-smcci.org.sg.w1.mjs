export const meta = { task: 'SG-smcci.org.sg', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'moe_certified'],
  canary: { found: 'Positano Restaurant Pte Ltd', not_found: 'Kedai Runcit Khayalan Sdn Bhd' } };

const PAGE = 'https://www.smcci.org.sg/membership-directory/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped before comparing, so "ACME TRADING PTE. LTD." matches "Acme Trading Pte Ltd".
const LEGAL_FORMS = new Set(['pte', 'ltd', 'limited', 'sdn', 'bhd', 'berhad', 'llp', 'llc', 'plc', 'inc', 'co', 'private']);

function coreName(str) {
  const tokens = (str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')          // accents
    .toLowerCase()
    .replace(/[‘’'`]/g, '')                             // apostrophes: "Cherry’s" = "Cherrys"
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return tokens.filter((t) => !LEGAL_FORMS.has(t)).join('');
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#0?38;|&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;/gi, '’')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull (name, moe) pairs out of the members table embedded in the page. Returns [] if no such table. */
function parseMembers(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const out = [];
    for (const row of rows) {
      const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => cleanText(c));
      if (cells.length >= 1 && cells[0]) out.push({ name: cells[0], moe_certified: cells[1] || '' });
    }
    if (out.length >= 10) return out;
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = String(keyword || '').trim();
    if (!query) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|just a moment/i.test(html.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: 'bot check page' };
    }

    const members = parseMembers(html);
    if (!members) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: cleanText(html).slice(0, 300) };
    }

    const want = coreName(query);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'name has no letters or digits after normalising' };
    }

    const records = members
      .filter((m) => coreName(m.name) === want)
      .map((m) => ({ name: m.name, moe_certified: m.moe_certified }));

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: `${members.length} members listed; no match for "${query}"` };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE,
      excerpt: records.map((r) => r.name).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
