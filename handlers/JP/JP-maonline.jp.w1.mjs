export const meta = {
  task: 'JP-maonline.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'securities_code', 'edinet_code', 'address', 'representative', 'listing_status'],
  canary: { found: '極洋', not_found: 'ゼノデザイン架空株式会社' },
};

// M&A Online company directory: GET https://maonline.jp/db/companies?q=NAME (&page=N, 25 rows per page).
// Each result row links to the company page /db/companies/<securities code>, which holds legal name,
// securities code, EDINET code, address and representative.

const BASE = 'https://maonline.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 25;
const MAX_PAGES = 8;
const BUDGET_MS = 40000;

const JP_FORM_PREFIX = /^(株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|特例有限会社|\(株\)|\(有\)|\(同\))/;
const JP_FORM_SUFFIX = /(株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|特例有限会社|\(株\)|\(有\)|\(同\))$/;
const EN_FORM_SUFFIX = /[\s,.]*(co\.?\s*,?\s*ltd\.?|company|limited|corporation|incorporated|inc\.?|corp\.?|ltd\.?|kk)$/i;

function nfkc(s) {
  return String(s || '').normalize('NFKC');
}

/** The company name without its legal form (株式会社 etc. at either end). */
function coreName(keyword) {
  let s = nfkc(keyword).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) {
    s = s.replace(JP_FORM_PREFIX, '').replace(JP_FORM_SUFFIX, '').trim();
  }
  return s;
}

/** Comparison key: case, width, punctuation, spaces and legal form removed. */
function matchKey(s) {
  return coreName(s).toLowerCase().replace(EN_FORM_SUFFIX, '').replace(/[\s　\p{P}\p{S}]/gu, '');
}

/** The site writes Latin letters, digits and spaces at full width; a half-width query finds nothing. */
function siteWidth(s) {
  return nfkc(s)
    .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    .replace(/ /g, '　');
}

function clean(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Result rows of a search page: { code, name, status } (status = '上場廃止' etc., or ''). */
function parseRows(html) {
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || '';
  const rows = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const code = row.match(/href="\/db\/companies\/([0-9A-Za-z]+)"/)?.[1];
    const cell = row.match(/<td class="col_date[^"]*"[^>]*>\s*<div class="td_wrap">([\s\S]*?)<\/div>/i)?.[1];
    if (!code || cell === undefined) continue;
    const status = clean(cell.match(/<span class="icon_haishi">([\s\S]*?)<\/span>/i)?.[1] || '');
    const name = clean(cell.replace(/<span[\s\S]*?<\/span>/gi, ''));
    out.push({ code, name, status });
  }
  return out;
}

function sameCompany(rowName, key) {
  if (matchKey(rowName) === key) return true;
  // Some names carry an English form in brackets, e.g. テックポイント・インク（Techpoint, Inc.）.
  return matchKey(rowName.replace(/[（(][^）)]*[）)]/g, '')) === key;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.5',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function httpFail(res, url) {
  if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
  return fail('http_error', url, `HTTP ${res.status}`);
}

function errorReason(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const searchBase = `${BASE}/db/companies`;
  try {
    const core = coreName(keyword);
    const key = matchKey(keyword);
    if (!core || !key) return fail('other', searchBase, 'no company name to search for');

    const query = siteWidth(core);
    const searchUrl = (page) => `${searchBase}?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ''}`;
    const firstUrl = searchUrl(1);

    let match = null;
    let total = 0;
    for (let page = 1; ; page++) {
      const url = searchUrl(page);
      const res = await get(url);
      if (!res.ok) return httpFail(res, url);
      const html = await res.text();

      if (!/table table_pro/.test(html)) {
        if (/captcha|cf-chl|just a moment|are you a robot|access denied/i.test(html)) {
          return fail('blocked', url, 'bot check page');
        }
        return fail('layout_changed', url, clean(html).slice(0, 300));
      }

      const rows = parseRows(html);
      total += rows.length;
      match = rows.find((row) => sameCompany(row.name, key)) || null;
      if (match) break;
      if (rows.length < PAGE_SIZE) break; // last page of results
      if (page >= MAX_PAGES) {
        return fail('other', url, `more than ${MAX_PAGES * PAGE_SIZE} results for "${query}"; the match could not be checked`);
      }
      if (Date.now() - started > BUDGET_MS) return fail('timeout', url, 'stopped paging after 40 s');
    }

    if (!match) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `The search for "${query}" returned ${total} row(s); none has this name`,
      };
    }

    const detailUrl = `${BASE}/db/companies/${match.code}`;
    const detail = await get(detailUrl);
    if (!detail.ok) return httpFail(detail, detailUrl);
    const dhtml = await detail.text();

    const fields = {};
    for (const m of dhtml.matchAll(/<th>([\s\S]*?)<\/th>\s*<td>([\s\S]*?)<\/td>/g)) {
      fields[clean(m[1])] = clean(m[2]);
    }
    if (!fields['会社名']) return fail('layout_changed', detailUrl, clean(dhtml).slice(0, 300));

    const record = {
      name: fields['会社名'] || match.name,
      securities_code: fields['証券コード'] || match.code,
      edinet_code: fields['EDINETコード'] || '',
      address: fields['住所'] || '',
      representative: fields['代表者名'] || '',
      listing_status: match.status,
    };

    return {
      status: 'found',
      reason: '',
      records: [record],
      source_url: detailUrl,
      excerpt: `${record.name} | 証券コード ${record.securities_code} | ${record.address}`.slice(0, 500),
    };
  } catch (err) {
    return fail(errorReason(err), searchBase, String(err?.message || err));
  }
}
