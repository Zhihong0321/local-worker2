export const meta = {
  task: 'DE-dakks.de',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'address', 'accreditation_number', 'valid_since', 'scope_pdf_url'],
  canary: { found: 'DEKRA Automobil GmbH DEKRA Werkstofflabor', not_found: 'Xyzqwertprüf Nullgesellschaft GmbH' },
};

const BASE = 'https://www.dakks.de';
const SEARCH_PAGE = `${BASE}/de/akkreditierte-stellen-suche.html`;
const RESULT_PAGE = `${BASE}/de/akkreditierte-stellen-suchergebnis.html`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 10;        // 10 x 50 results
const DEADLINE_MS = 45000;   // stop paging after this, well inside the 60 s limit

const LEGAL_FORMS = new Set(['gmbh', 'mbh', 'ag', 'kg', 'kgaa', 'ug', 'se', 'ohg', 'gbr', 'ev', 'co', 'partg', 'ltd', 'llc', 'inc', 'sa', 'bv', 'ab', 'oy', 'as', 'srl', 'spa']);

function transliterate(s) {
  return (s || '')
    .replace(/ä/gi, (m) => (m === 'Ä' ? 'Ae' : 'ae'))
    .replace(/ö/gi, (m) => (m === 'Ö' ? 'Oe' : 'oe'))
    .replace(/ü/gi, (m) => (m === 'Ü' ? 'Ue' : 'ue'))
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

/** Normalised name tokens without trailing legal-form words, e.g. "DEKRA Automobil GmbH" -> ["dekra", "automobil"]. */
function nameCore(s) {
  const tokens = transliterate(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens;
}

function sameName(a, b) {
  return a.length > 0 && a.length === b.length && a.every((t, i) => t === b[i]);
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cookieHeader(res, jar) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) {
    const pair = c.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseTeasers(html) {
  const parts = html.split('<div class="mod-as-list-teaser">').slice(1);
  return parts.map((part) => {
    const category = cleanText((part.match(/mod-as-list-teaser__category">([\s\S]*?)<\/div>/) || [])[1]);
    const headM = part.match(/<h3 class="mod-as-list-teaser__headline">\s*<a\s+href="([^"]*akkreditierte-stelle\.html\?id=[^"]+)">([\s\S]*?)<\/a>/);
    const address = cleanText((part.match(/mod-as-list-teaser__description">([\s\S]*?)<\/div>/) || [])[1]);
    const metaM = part.match(/mod-as-list-teaser__meta">([\s\S]*?)<\/div>/);
    const metaText = cleanText(metaM ? metaM[1] : '');
    const accM = metaText.match(/(D-[A-Z0-9-]+)/);
    const validM = metaText.match(/G[üu]ltig seit:\s*([0-9.]+)/i);
    const scopeM = part.match(/href="(files\/data\/as\/pdf\/[^"]+\.pdf)"/i);
    if (!headM) return null;
    return {
      name: cleanText(headM[2]),
      category,
      address,
      accreditation_number: accM ? accM[1] : '',
      valid_since: validM ? validM[1] : '',
      scope_pdf_url: scopeM ? new URL(scopeM[1], BASE).href : '',
      detail_url: new URL(decodeEntities(headM[1]), BASE).href,
    };
  }).filter(Boolean);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const jar = new Map();
  const headers = { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7' };
  let lastUrl = SEARCH_PAGE;
  try {
    const core = nameCore(keyword);
    if (core.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_PAGE, excerpt: 'empty company name' };
    }
    const searchText = core.join(' ');

    // 1. Search page: session cookie + CSRF token of the search form.
    const pageRes = await fetch(SEARCH_PAGE, { headers, signal: AbortSignal.timeout(25000) });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_PAGE, excerpt: `HTTP ${pageRes.status}` };
    }
    if (!pageRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH_PAGE, excerpt: `HTTP ${pageRes.status}` };
    }
    const pageHtml = await pageRes.text();
    const tokenM = pageHtml.match(/id="as-search-form"[\s\S]*?name="REQUEST_TOKEN" value="([^"]+)"/);
    if (!tokenM) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_PAGE, excerpt: 'search form or token not found' };
    }
    const cookies = cookieHeader(pageRes, jar);

    // 2. Post the search form exactly as the page does (all fields present).
    const body = new URLSearchParams({
      REQUEST_TOKEN: tokenM[1],
      as_search_form_submit: '1',
      as_search_string: searchText,
      as_search_searchin: 'all',
      as_search_type: 'all',
      'as_search_state[]': 'all',
      as_search_status: 'all',
      as_search_location: 'all',
      as_submit: 'Suche starten',
    });
    const postRes = await fetch(SEARCH_PAGE, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, Referer: SEARCH_PAGE },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_PAGE, excerpt: `HTTP ${postRes.status}` };
    }
    if (postRes.status !== 303 && postRes.status !== 302) {
      return { status: 'couldnt_check', reason: postRes.ok ? 'layout_changed' : 'http_error', records: [], source_url: SEARCH_PAGE, excerpt: `search POST gave HTTP ${postRes.status}` };
    }
    const cookies2 = cookieHeader(postRes, jar);

    // 3. Read the result pages (page 1 first, then further pages while needed).
    const allRecords = [];
    let totalPages = 1;
    let totalHits = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) break;
      const url = page === 1 ? RESULT_PAGE : `${RESULT_PAGE}?page=${page}`;
      lastUrl = url;
      const res = await fetch(url, { headers: { ...headers, Cookie: cookies2, Referer: SEARCH_PAGE }, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      if (/captcha/i.test(html) && !/mod-as-list-teaser/.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'captcha page' };
      }
      if (page === 1) {
        if (/Ihre Suche ergab\s+0\s+Treffer/.test(html)) {
          return {
            status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE,
            excerpt: `DAkkS search for "${searchText}": 0 results`,
          };
        }
        const hitsM = html.match(/Treffer:\s*([\d.]+)/);
        if (!hitsM || !/mod_dakksAsSearchResult/.test(html)) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
        }
        totalHits = Number(hitsM[1].replace(/\./g, ''));
        const pagesM = html.match(/Seite\s+\d+\s+von\s+(\d+)/);
        totalPages = pagesM ? Number(pagesM[1]) : 1;
      }
      const teasers = parseTeasers(html);
      allRecords.push(...teasers);
      // Stop early: every exact match is already found on a page we read.
      if (page >= totalPages) break;
    }

    const exact = allRecords.filter((r) => sameName(nameCore(r.name), nameCore(keyword)));
    if (exact.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: exact.map(({ detail_url, ...r }) => r),
        source_url: exact[0].detail_url,
        excerpt: cleanText(`${exact[0].category} ${exact[0].name} ${exact[0].address} ${exact[0].accreditation_number} Gültig seit: ${exact[0].valid_since}`).slice(0, 400),
      };
    }

    // No exact match. Only a complete search may say "not listed".
    const readAll = totalPages <= MAX_PAGES && allRecords.length >= (totalHits ?? 0);
    if (!readAll) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
        excerpt: `search has ${totalHits} hits over ${totalPages} pages; read ${allRecords.length} without an exact match`,
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE,
      excerpt: `DAkkS search for "${searchText}": ${totalHits} hits, none with the same name`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
