export const meta = {
  task: 'JP-ja.nc-net.or.jp',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'address', 'employees', 'url'],
  canary: { found: '植木プラスチック　株式会社', not_found: 'ヤマダテストゼロ株式会社' },
};

const SEARCH = 'https://ja.nc-net.or.jp/search/search/';
const SITE = 'https://ja.nc-net.or.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const MAX_PAGES = 5;          // 50 hits at most; beyond that we say so instead of guessing
const BUDGET_MS = 40000;      // stop paging well before the 60 s limit

/** Full normalised form: width-folded, lower case, only letters and digits. */
function fullNorm(str) {
  return String(str || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/** Normalised core name: legal form removed (株式会社, 有限会社, Co., Ltd., Inc. ...). */
function core(str) {
  const s = String(str || '').normalize('NFKC').toLowerCase()
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|企業組合|協同組合|kabushiki\s*kaisha|co\.?\s*,?\s*ltd\.?|\bltd\.?|\binc\.?|\bcorp\.?|\bllc\b|k\.k\./g, ' ');
  return fullNorm(s);
}

/** A comparison key; falls back to the full name when only a legal form was given. */
function key(str) {
  return core(str) || fullNorm(str);
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Each result is an <h2 class="ttl-h3-03"> holding the company link and a span with address and staff count. */
function parsePage(html) {
  const entries = [];
  const re = /<h2 class="ttl-h3-03">([\s\S]*?)<\/h2>/g;
  let m;
  while ((m = re.exec(html))) {
    const inner = m[1];
    const link = inner.match(/href="\/company\/(\d+)\/"/);
    if (!link) continue;
    const name = clean(inner.match(/<a [^>]*>([\s\S]*?)<\/a>/)?.[1] || '');
    const addrText = clean(inner.match(/<span class="address">([\s\S]*?)<\/span>/)?.[1] || '');
    const am = addrText.match(/所在地[:：]\s*(.*?)\s*(?:社員数\s*(.*))?$/);
    entries.push({
      name,
      company_id: link[1],
      address: am ? am[1] : addrText,
      employees: am && am[2] ? am[2] : '',
      url: `${SITE}/company/${link[1]}/`,
      text: clean(inner).slice(0, 300),
    });
  }
  return entries;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const fail = (status, reason, source_url, excerpt) =>
    ({ status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) });
  const pageUrl = (pno) => `${SEARCH}?w=${encodeURIComponent(name)}${pno > 1 ? `&pno=${pno}` : ''}`;

  try {
    if (!name) return fail('couldnt_check', 'other', SEARCH, 'empty keyword');
    const want = key(name);

    let pages = 1;
    let total = 0;
    for (let pno = 1; pno <= Math.min(pages, MAX_PAGES); pno++) {
      if (pno > 1 && Date.now() - started > BUDGET_MS) {
        return fail('couldnt_check', 'timeout', pageUrl(1), `stopped after ${pno - 1} of ${pages} result pages`);
      }
      const url = pageUrl(pno);
      const res = await fetch(url, {
        // Accept-Encoding: identity keeps the body uncompressed. With gzip, the runner's process.exit() can crash
        // Node on Windows (libuv assertion) while the decompression stream is still open.
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8', 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return fail('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return fail('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
      }
      const html = await res.text();

      if (pno === 1) {
        const countM = html.match(/<em class="em-02">([\d,]+)<\/em>\s*件/);
        if (!countM) {
          if (html.includes('合致する工場はありませんでした')) {
            return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `0 hits for "${name}"` };
          }
          return fail('couldnt_check', 'layout_changed', url, html.slice(0, 300));
        }
        total = Number(countM[1].replace(/,/g, ''));
        pages = Math.ceil(total / PAGE_SIZE);
      }

      const entries = parsePage(html);
      if (pno === 1 && total > 0 && entries.length === 0) {
        return fail('couldnt_check', 'layout_changed', url, `count ${total} shown but no result entries parsed`);
      }
      const matches = entries.filter((e) => key(e.name) === want);
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches.map(({ text, ...rec }) => rec),
          source_url: url,
          excerpt: matches[0].text,
        };
      }
    }

    if (pages > MAX_PAGES) {
      return fail('couldnt_check', 'other', pageUrl(1),
        `${total} search hits for "${name}"; the first ${MAX_PAGES * PAGE_SIZE} were checked and none matched`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: pageUrl(1), excerpt: `${total} search hits for "${name}", none with this company name` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', pageUrl(1), String(err?.message || err));
  }
}
