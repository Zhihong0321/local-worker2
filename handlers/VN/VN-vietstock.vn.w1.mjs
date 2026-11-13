export const meta = { task: 'VN-vietstock.vn', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'full_name', 'ticker', 'exchange', 'url'],
  canary: { found: 'CTCP Sữa Việt Nam', not_found: 'Công ty TNHH Không Tồn Tại Xyzzy Quốc Tế' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITEMAP = 'https://finance.vietstock.vn/sitemap.xml';
const SEARCH = 'https://finance.vietstock.vn/search-stock';
// Company pages look like /VNM-ctcp-sua-viet-nam.htm (ticker, then the legal name in ASCII slug form).
const COMPANY_LOC = /<loc>https:\/\/finance\.vietstock\.vn\/([A-Z0-9]{2,10})-([a-z0-9-]+)\.htm<\/loc>/g;
const MIN_COMPANY_ENTRIES = 500; // the index has ~2,900 company pages; far fewer means it changed or was cut short

/** Lower-case ASCII words: strips Vietnamese diacritics, punctuation and extra spaces. */
function norm(s) {
  return (s || '').replace(/Đ/g, 'D').replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The name without legal form, from either the start (CTCP, Cong ty co phan, TNHH) or the end (Joint Stock Company, Sdn Bhd). */
function core(normalised) {
  let s = normalised;
  let prev;
  do {
    prev = s;
    s = s.replace(/^(cong ty co phan|cong ty cp|cong ty trach nhiem huu han|cong ty tnhh|cong ty|co phan|ctcp|tnhh|jsc)\s+/, '')
      .replace(/\s+(joint stock company|company limited|co ltd|ltd|sdn bhd|bhd|jsc|ctcp|tnhh|mot thanh vien|corporation|corp|inc|llc)$/, '');
  } while (s !== prev);
  return s.trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Best effort: the site's own name and exchange for a ticker. Never throws; returns {} on any problem. */
async function siteNameFor(ticker) {
  try {
    const url = `${SEARCH}?query=${encodeURIComponent(ticker)}&page=1&pageSize=10&skip=0&languageId=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://finance.vietstock.vn/' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return {};
    const j = JSON.parse(await res.text());
    const hit = (j.data || []).find((d) => d.Code === ticker && d.Type === 2);
    return hit ? { full_name: hit.FullName || '', exchange: hit.Exchange || '' } : {};
  } catch (e) {
    return {};
  }
}

/** The site's own search: companies whose short name or ticker is exactly the keyword. */
async function searchByName(keyword, kw) {
  try {
    const url = `${SEARCH}?query=${encodeURIComponent(keyword)}&page=1&pageSize=10&skip=0&languageId=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://finance.vietstock.vn/' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}`, hits: [] };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}`, hits: [] };
    const j = JSON.parse(await res.text());
    if (!j || j.code !== 0 || !Array.isArray(j.data)) return { ok: false, reason: 'layout_changed', excerpt: JSON.stringify(j).slice(0, 300), hits: [] };
    const hits = j.data
      .filter((d) => d.Type === 2 && (norm(d.Name) === kw || String(d.Code).toLowerCase() === kw))
      .map((d) => ({ name: d.FullName || d.Name, full_name: d.FullName || '', ticker: d.Code, exchange: d.Exchange || '',
        url: String(d.URL || '').replace(/^http:/, 'https:') }));
    return { ok: true, reason: '', excerpt: '', hits };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err), hits: [] };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = norm(keyword);
    const kwCore = core(kw);
    if (!kwCore) return couldnt('other', SITEMAP, 'the company name is empty after normalising');

    const res = await fetch(SITEMAP, {
      headers: { 'User-Agent': UA, 'Accept': 'application/xml,text/xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', SITEMAP, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', SITEMAP, `HTTP ${res.status}`);

    const xml = await res.text();
    if (!xml.includes('<urlset')) return couldnt('layout_changed', SITEMAP, xml.slice(0, 300));

    let entries = 0;
    const matches = [];
    for (const m of xml.matchAll(COMPANY_LOC)) {
      entries++;
      const ticker = m[1];
      const slug = m[2];
      const isMatch = core(slug.replace(/-/g, ' ')) === kwCore || ticker.toLowerCase() === kw;
      // One record per company: a company can have a Vietnamese and an English page under the same ticker.
      if (isMatch && !matches.some((x) => x.ticker === ticker)) {
        matches.push({ ticker, slug, url: `https://finance.vietstock.vn/${ticker}-${slug}.htm` });
      }
    }
    if (entries < MIN_COMPANY_ENTRIES) {
      return couldnt('layout_changed', SITEMAP, `only ${entries} company pages in the index`);
    }

    if (matches.length === 0) {
      // Short brand names (e.g. VINAMILK) are not in the legal-name slugs; the site's own search knows them.
      const byName = await searchByName(keyword, kw);
      if (!byName.ok) return couldnt(byName.reason, SEARCH, byName.excerpt);
      if (byName.hits.length === 0) {
        return {
          status: 'not_found', reason: '', records: [], source_url: SITEMAP,
          excerpt: `No company page on finance.vietstock.vn matches "${keyword}" (${entries} company pages checked)`,
        };
      }
      return {
        status: 'found', reason: '', records: byName.hits,
        source_url: byName.hits[0].url,
        excerpt: byName.hits.map((r) => `${r.ticker} | ${r.full_name}${r.exchange ? ' | ' + r.exchange : ''}`).join('; ').slice(0, 500),
      };
    }

    const records = [];
    for (const m of matches) {
      const info = await siteNameFor(m.ticker);
      records.push({
        name: info.full_name || m.slug.replace(/-/g, ' '),
        full_name: info.full_name || '',
        ticker: m.ticker,
        exchange: info.exchange || '',
        url: m.url,
      });
    }
    return {
      status: 'found', reason: '', records,
      source_url: matches[0].url,
      excerpt: records.map((r) => `${r.ticker} | ${r.full_name || r.name}${r.exchange ? ' | ' + r.exchange : ''}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', SITEMAP, String(err?.message || err));
  }
}
