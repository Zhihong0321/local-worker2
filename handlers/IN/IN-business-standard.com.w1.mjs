export const meta = {
  task: 'IN-business-standard.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_short', 'bse_code', 'nse_code', 'exchange', 'index_code', 'series', 'sector', 'page_url'],
  canary: { found: '3M India Ltd', not_found: 'Shree Naklee Udyog Pvt Ltd' },
};

// The site publishes a sitemap of company pages (listed companies only). Its robots.txt lists it as a Sitemap,
// and the /search pages are disallowed there, so this handler never uses search.
const LIST_INDEX = 'https://www.business-standard.com/sitemap/companies-sitemap.xml';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_RE = /\/companies\/quarterly-results\/([a-z0-9-]+?)-quarterly-results-(\d+)$/;
const LEGAL = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'plc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation']);

/** Letters and digits only, legal-form words dropped: "3M India Pvt. Ltd." and "3M India Ltd" give the same key. */
function nameKey(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t && !LEGAL.has(t)).join('');
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Thrown inside the lookup to stop with a ready answer. */
class Stop extends Error {
  constructor(result) { super('stop'); this.result = result; }
}

async function getText(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new Stop(couldnt(timeout ? 'timeout' : 'other', url, String(e?.message || e).slice(0, 300)));
  }
  if (res.status === 403 || res.status === 429) throw new Stop(couldnt('blocked', url, `HTTP ${res.status}`));
  if (!res.ok) throw new Stop(couldnt('http_error', url, `HTTP ${res.status}`));
  return res.text();
}

/** Reads the "companyDetails" JSON object the company page embeds (brace matching, string-aware). */
function companyDetails(html) {
  const at = html.indexOf('"companyDetails":');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').normalize('NFC').trim();
  try {
    if (!input) return couldnt('other', LIST_INDEX, 'empty company name');
    // The site lists company names in English. A name in another script cannot be matched, so say so instead of "not found".
    if (/[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]/u.test(input)) {
      return couldnt('other', LIST_INDEX, 'name is not written in Latin letters; the site lists company names in English only');
    }
    const key = nameKey(input);
    if (!key) return couldnt('other', LIST_INDEX, 'no distinctive words left once the legal form is removed');

    // 1. The company-page sitemap index, then its child sitemaps.
    const indexXml = await getText(LIST_INDEX);
    const childUrls = [...indexXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])
      .filter((u) => /quarterly-results/.test(u) && /\.xml$/.test(u));
    if (!childUrls.length) throw new Stop(couldnt('layout_changed', LIST_INDEX, indexXml.slice(0, 300)));

    const childXml = await Promise.all(childUrls.map(getText));
    const pages = [];
    for (const xml of childXml) {
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        const pm = m[1].match(PAGE_RE);
        if (pm) pages.push({ url: m[1], key: nameKey(pm[1]) });
      }
    }
    if (!pages.length) throw new Stop(couldnt('layout_changed', childUrls[0], 'no company pages in the sitemap'));

    // 2. Same normalised name on the list?
    const hits = pages.filter((p) => p.key === key);
    if (!hits.length) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_INDEX,
        excerpt: `No company page for "${input}" in the site's list of ${pages.length} company pages`,
      };
    }

    // 3. Read each matching page and confirm its official name.
    const pageHtml = await Promise.all(hits.map((h) => getText(h.url).then((html) => ({ h, html }))));
    const records = [];
    for (const { h, html } of pageHtml) {
      const d = companyDetails(html);
      if (!d) throw new Stop(couldnt('layout_changed', h.url, 'no companyDetails data on the company page'));
      if (nameKey(d.company_name) !== key) continue;
      records.push({
        name: d.company_name || '',
        name_short: d.company_name_short || '',
        bse_code: d.bse_code == null ? '' : String(d.bse_code),
        nse_code: d.nse_code || '',
        exchange: d.exchange || '',
        index_code: d.index_code || '',
        series: d.series || '',
        sector: d.sect_name || '',
        page_url: h.url,
      });
    }
    if (!records.length) {
      return couldnt('layout_changed', hits[0].url, 'company page name does not match the list entry');
    }

    const r = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: r.page_url,
      excerpt: `${r.name}: BSE ${r.bse_code || '-'}, NSE ${r.nse_code || '-'} (business-standard.com company page)`,
    };
  } catch (err) {
    if (err instanceof Stop) return err.result;
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', LIST_INDEX, String(err?.message || err).slice(0, 300));
  }
}
