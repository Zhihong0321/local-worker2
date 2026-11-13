export const meta = { task: 'GB-companycheck.co.uk', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'company_number', 'status', 'address', 'detail_url'],
  canary: { found: 'TESCO STORES LIMITED', not_found: 'Zzqxv Blorfington Widgets Ltd' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://companycheck.co.uk';
const LEGAL_FORMS = new Set(['LIMITED', 'LTD', 'PLC', 'LLP', 'LP', 'CIC']);

/** Compare names: case, punctuation, '&' vs AND, and a trailing legal form are ignored. */
function normName(str) {
  const words = (str || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}/search?term=${encodeURIComponent(String(keyword || '').trim())}`;
  try {
    const q = String(keyword || '').trim();
    if (!q) return couldnt('other', searchUrl, 'empty company name');

    const res = await fetch(searchUrl, {
      // identity: a compressed body makes the worker's Node exit with a libuv assertion on Windows (exit 127).
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Encoding': 'identity' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', searchUrl, `HTTP ${res.status}`);
    if (/\/login/i.test(new URL(res.url).pathname)) return couldnt('blocked', res.url, 'redirected to a login page');

    const html = await res.text();
    if (/Just a moment|cf-chl|captcha|Attention Required/i.test(html.slice(0, 20000))) {
      return couldnt('blocked', searchUrl, 'bot check or captcha page');
    }

    // Only the company results block: from its container up to its pagination (director results come after).
    const start = html.indexOf('id="js-company-results"');
    const endAt = html.indexOf('id="js-company-pagination"', start);
    if (start < 0 || endAt < 0) return couldnt('layout_changed', searchUrl, html.slice(0, 300));
    const block = html.slice(start, endAt);

    const countMatch = block.match(/(\d[\d,]*)\s+results?\s+found/i) || html.match(/(\d[\d,]*)\s+results?\s+found/i);
    if (!countMatch) return couldnt('layout_changed', searchUrl, 'no result count on the page');
    const total = parseInt(countMatch[1].replace(/,/g, ''), 10);

    const cards = block.split('<div itemprop="itemListElement"').slice(1).filter((c) => c.includes('class="result__title"'));
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: clean(countMatch[0]) };
    }
    if (cards.length === 0) return couldnt('layout_changed', searchUrl, `count ${total} but no result cards`);

    const kw = normName(q);
    const records = [];
    for (const card of cards) {
      const nameM = card.match(/<span itemprop="legalName">([\s\S]*?)<\/span>/);
      if (!nameM) continue;
      const name = clean(nameM[1]);
      if (normName(name) !== kw) continue;
      const numM = card.match(/Company No:\s*([A-Za-z0-9]+)/);
      const addrM = card.match(/class="result__address">([\s\S]*?)<\/p>/);
      const hrefM = card.match(/href="(\/company\/[^"]+)" class="result__title"/);
      const statusM = card.match(/<span class="result__status[^"]*">\s*([^<]*?)\s*<\/span>/g) || [];
      const status = statusM.map((s) => clean(s)).find((s) => s && !/^Company No/i.test(s)) || '';
      records.push({
        name,
        company_number: numM ? numM[1] : '',
        status,
        address: addrM ? clean(addrM[1]) : '',
        detail_url: hrefM ? new URL(hrefM[1], BASE).href : '',
      });
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: `${total} results for "${q}"; ${records.length} with the same name` };
    }
    if (total > cards.length) {
      // The company may be on a later page, which this handler does not read.
      return couldnt('other', searchUrl, `no exact match on page 1 (${cards.length} of ${total} results)`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `${total} results for "${q}", none with the same name` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
