export const meta = { task: 'IN-moneycontrol.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'isin', 'symbol', 'bse_code', 'sector', 'moneycontrol_code', 'profile_url'],
  canary: { found: 'Infosys', not_found: 'दृष्टि टेस्ट प्राइवेट लिमिटेड' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL = new Set(['limited', 'ltd', 'private', 'pvt', 'company', 'co', 'llp', 'plc']);

/** Compare key: lower case, "&" as "and", punctuation and spaces removed, legal-form words dropped. */
function nameKey(str) {
  const words = String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL.has(w));
  return words.join('');
}

/** The display name before the "<span>ISIN, SYMBOL, BSE code</span>" part. */
function displayName(pdt) {
  return String(pdt || '').split('<span>')[0];
}

/** Parse "INE002A01018, RELIANCE, 500325" from the span into its parts. */
function parseIds(pdt) {
  const m = String(pdt || '').match(/<span>([^<]*)<\/span>/);
  const parts = m ? m[1].split(',').map((s) => s.trim()) : [];
  const isin = parts.find((p) => /^IN[A-Z0-9]{10}$/.test(p)) || '';
  const rest = parts.filter((p) => p && p !== isin);
  return { isin, symbol: rest[0] || '', bse_code: rest[1] || '' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await run(keyword);
  // On Windows, Node 24 aborts with "Assertion failed ... async.c" when the runner exits right after a fetch
  // (the keep-alive socket is still closing). A short pause lets it close first. Verified: exit 0 with 300 ms+.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return result;
}

async function run(keyword) {
  const kw = nameKey(keyword);
  let searchUrl = '';
  try {
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }
    searchUrl = 'https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?classic=true&type=1&format=json&query=' +
      encodeURIComponent(String(keyword).trim());

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const bot = /access denied|captcha|are you a robot|verify you are human/i.test(text);
      return { status: 'couldnt_check', reason: bot ? 'blocked' : 'layout_changed', records: [], source_url: searchUrl,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 300) };
    }
    if (!Array.isArray(data)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl,
        excerpt: text.slice(0, 300) };
    }

    const noResult = (x) => /No Result Available/i.test(x?.pdt_dis_nm || '') || !x?.link_src;
    const valid = data.filter((x) => x && typeof x.name === 'string' && typeof x.link_src === 'string' && !noResult(x));
    if (valid.length === 0) {
      if (data.length === 0 || data.every(noResult)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 results for "${keyword}"` };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl,
        excerpt: JSON.stringify(data[0]).slice(0, 300) };
    }

    const matches = valid.filter((x) => nameKey(x.name) === kw || nameKey(displayName(x.pdt_dis_nm)) === kw);
    if (matches.length === 0) {
      const shown = valid.slice(0, 5).map((x) => x.name).join('; ');
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `No exact match for "${keyword}". Site returned: ${shown}` };
    }

    const seen = new Set();
    const records = [];
    for (const x of matches) {
      if (seen.has(x.link_src)) continue;
      seen.add(x.link_src);
      const ids = parseIds(x.pdt_dis_nm);
      records.push({
        name: x.name,
        isin: ids.isin,
        symbol: ids.symbol,
        bse_code: ids.bse_code,
        sector: x.sc_sector || '',
        moneycontrol_code: x.sc_id || '',
        profile_url: x.link_src,
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records[0].name} | ISIN ${records[0].isin} | ${records[0].symbol} | ${records[0].sector}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
