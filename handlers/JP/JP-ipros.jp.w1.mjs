export const meta = {
  task: 'JP-ipros.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'listed_name', 'company_id', 'established', 'capital', 'employees', 'address', 'phone', 'url'],
  canary: { found: '株式会社水野鉄工所', not_found: '株式会社ゼッタイニソンザイシナイ' },
};

const SITE = 'https://mono.ipros.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;      // the site shows 45 results per page; the exact name is ranked near the top
const MAX_DETAILS = 5;    // company detail pages read per lookup
const NO_RESULT_TEXT = '条件に一致する企業が見つかりませんでした';

// Japanese and English legal-form words, removed before two names are compared.
// The text is NFKC-normalised first, so （株） has already become (株).
const LEGAL_FORM_RE = /株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|\(合\)|co\.?\s*,?\s*ltd\.?|\binc\.?|\bltd\.?|\bcorp\.?/gi;

class CheckError extends Error {
  constructor(reason, source_url, excerpt) {
    super(reason);
    this.reason = reason;
    this.source_url = source_url;
    this.excerpt = excerpt;
  }
}

function verdict(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt };
}

/** Comparison key: width, case, spaces, punctuation and legal form removed. */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(LEGAL_FORM_RE, '')
    .toLowerCase()
    .replace(/[\s・.,、。()\[\]「」『』&\-‐‑‒–—―~～'"“”]/g, '');
}

/** The name to send to the site's search: legal form removed, spaces tidied. */
function coreName(keyword) {
  return String(keyword ?? '')
    .normalize('NFKC')
    .replace(LEGAL_FORM_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decode(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchUrl(core, page) {
  const u = new URL('/search/company/', SITE);
  u.searchParams.set('keyword', core);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

/** Fetch one page. Throws a CheckError for blocked, http_error and timeout. */
async function fetchPage(url, started) {
  // A new fetch may start only in the first 30 s, so with its own 25 s limit the call ends before 60 s.
  if (Date.now() - started > 30000) {
    throw new CheckError('timeout', url, 'the lookup passed 30 s, so this page was not fetched');
  }
  let res;
  let html;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      throw new CheckError('blocked', url, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new CheckError('http_error', url, `HTTP ${res.status}`);
    }
    html = await res.text();
  } catch (err) {
    if (err instanceof CheckError) throw err;
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new CheckError(timedOut ? 'timeout' : 'other', url, String(err?.message || err).slice(0, 300));
  }
  return html;
}

function invalidPage(url, html) {
  if (/captcha|challenge-platform|cf-chl|アクセスが集中/i.test(html)) {
    return new CheckError('blocked', url, 'bot check or captcha page: ' + decode(html).slice(0, 200));
  }
  return new CheckError('layout_changed', url, decode(html).slice(0, 300));
}

function parseSearch(html) {
  const countM = html.match(/全\s*([\d,]+)\s*件/);
  const total = countM ? Number(countM[1].replace(/,/g, '')) : null;
  const items = [];
  for (const m of html.matchAll(/<a\b([^>]*)class="search-result-company-item__name-link"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = (m[1] + m[2]).match(/href="\/company\/detail\/(\d+)\/?"/);
    if (href) items.push({ id: href[1], name: decode(m[3]) });
  }
  const noResult = html.includes(NO_RESULT_TEXT);
  return {
    total,
    items,
    noResult,
    valid: html.includes('イプロス') && (total !== null || noResult),
  };
}

function parseDetail(html) {
  const catchM = html.match(/<h2 class="company-summary__catch">([\s\S]*?)<\/h2>/);
  if (!catchM) return null;
  const info = { legal_name: decode(catchM[1]), established: '', capital: '', employees: '', address: '', phone: '' };
  const rowRe = /company-summary__description-label">([^<]*)<\/span><span class="company-summary__description-secondary">([^<]*)<\/span>/g;
  for (const m of html.matchAll(rowRe)) {
    const label = decode(m[1]);
    const value = decode(m[2]);
    if (label === '設立') info.established = value;
    else if (label === '資本金') info.capital = value;
    else if (label === '従業員数') info.employees = value;
    else if (label === '住所') info.address = value;
  }
  const tel = html.match(/class="company-summary__description-tell">([^<]*)<\/a>/);
  if (tel) info.phone = decode(tel[1]);
  return info;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const target = normalize(keyword);
  let sourceUrl = `${SITE}/search/company/`;
  try {
    if (!target) {
      throw new CheckError('other', sourceUrl, 'nothing left to search for after removing the legal form');
    }
    const core = coreName(keyword);

    const matches = [];
    let total = null;
    let seen = 0;
    let noResultOnFirstPage = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = searchUrl(core, page);
      if (page === 1) sourceUrl = url;
      const html = await fetchPage(url, started);
      const p = parseSearch(html);
      if (!p.valid) throw invalidPage(url, html);
      if (page === 1) {
        total = p.total ?? (p.noResult ? 0 : null);
        noResultOnFirstPage = p.noResult || p.total === 0;
      }
      if (p.items.length === 0) {
        if (page === 1 && !noResultOnFirstPage) {
          throw new CheckError('layout_changed', url, 'results count shown but no result rows parsed');
        }
        break;
      }
      seen += p.items.length;
      for (const item of p.items) {
        if (normalize(item.name) === target) matches.push(item);
      }
      if (total === null || seen >= total) break;
    }

    if (matches.length === 0) {
      if (noResultOnFirstPage || (total !== null && seen >= total)) {
        const said = noResultOnFirstPage ? `${SITE} says: ${NO_RESULT_TEXT}` : `none of the ${seen} results is named exactly like this`;
        return verdict('not_found', '', [], sourceUrl, said);
      }
      throw new CheckError(
        'other',
        sourceUrl,
        `no exact name among the first ${seen} of ${total ?? 'an unknown number of'} results; not checked further`,
      );
    }

    const unique = [...new Map(matches.map((m) => [m.id, m])).values()];
    const records = [];
    for (const m of unique.slice(0, MAX_DETAILS)) {
      const url = `${SITE}/company/detail/${m.id}/`;
      let info = null;
      try {
        info = parseDetail(await fetchPage(url, started));
      } catch (err) {
        if (!(err instanceof CheckError)) throw err;
      }
      records.push({
        name: info?.legal_name || m.name,
        listed_name: m.name,
        company_id: m.id,
        established: info?.established ?? '',
        capital: info?.capital ?? '',
        employees: info?.employees ?? '',
        address: info?.address ?? '',
        phone: info?.phone ?? '',
        url,
      });
    }

    const first = records[0];
    const more = unique.length > records.length ? `; ${unique.length - records.length} more match(es) not read` : '';
    return verdict(
      'found',
      '',
      records,
      first.url,
      `${first.name} | ${first.address || 'address not read'}${more}`,
    );
  } catch (err) {
    if (err instanceof CheckError) return verdict('couldnt_check', err.reason, [], err.source_url, err.excerpt);
    return verdict('couldnt_check', 'other', [], sourceUrl, String(err?.message || err).slice(0, 300));
  }
}
