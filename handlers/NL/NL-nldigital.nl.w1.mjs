export const meta = {
  task: 'NL-nldigital.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_page', 'address', 'phone', 'website', 'activities', 'supplier_of', 'specialisms'],
  canary: { found: 'Accenture B.V.', not_found: 'Bakkerij De Gouden Korst B.V.' },
};

// NLdigital publishes its member directory at /onze-leden/ (FacetWP). The search box is a plain GET parameter
// (?_search=...) and the server renders the matching member cards into the HTML, so no token or POST is needed.
const BASE = 'https://www.nldigital.nl';
const LIST_URL = `${BASE}/onze-leden/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 28;      // members per result page
const MAX_PAGES = 5;       // result pages read per lookup
const MAX_DETAIL = 5;      // member pages read per lookup
const SOFT_DEADLINE_MS = 30000; // no new request after 30 s, so the whole call stays under 60 s

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Drop a trailing Dutch legal form: B.V., BV, N.V., NV, V.O.F., VOF, C.V. */
function stripLegalForm(name) {
  let s = String(name || '').trim();
  const re = /[\s,]+(b\.?\s*v|n\.?\s*v|v\.?\s*o\.?\s*f|c\.?\s*v)\.?$/i;
  let prev;
  do {
    prev = s;
    s = s.replace(re, '').trim();
  } while (s !== prev);
  return s;
}

/** Two normalised keys: "&" read as "en", and "&" dropped (so "A&C" and "AC" can both match). */
function nameKeys(name) {
  const base = stripLegalForm(cleanText(name)).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return {
    withAnd: base.replace(/&/g, ' en ').replace(/[^\p{L}\p{N}]/gu, ''),
    noAnd: base.replace(/&/g, '').replace(/[^\p{L}\p{N}]/gu, ''),
  };
}

function sameCompany(a, b) {
  const ka = nameKeys(a);
  const kb = nameKeys(b);
  if (!ka.withAnd || !kb.withAnd) return false;
  return ka.withAnd === kb.withAnd || ka.noAnd === kb.noAnd;
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/** GET one page. Returns { text } or { fail, excerpt }. Never throws. */
async function fetchText(url, start) {
  if (Date.now() - start > SOFT_DEADLINE_MS) {
    return { fail: 'timeout', excerpt: 'not requested: the 60 s limit would have been exceeded' };
  }
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.7',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { fail: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e) };
  }
  if (res.status === 403 || res.status === 429) {
    return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return { fail: 'other', excerpt: 'could not read the body: ' + String(e?.message || e) };
  }
  return { text };
}

/** Member cards on a result page: <h3 class="card-title"><a href="/leden/...">Name</a></h3> */
function parseCards(html) {
  const cards = [];
  const re = /<h3 class="card-title"[^>]*>\s*<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    cards.push({ url: new URL(decodeEntities(m[1]), BASE).href, name: cleanText(m[2]) });
  }
  return cards;
}

function listItems(html, heading) {
  const re = new RegExp(`<h3>\\s*${heading}\\s*<\\/h3>\\s*<ul>([\\s\\S]*?)<\\/ul>`, 'i');
  const block = html.match(re)?.[1] || '';
  return [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => cleanText(x[1])).filter(Boolean);
}

/** Member page: name in <h1>, address block, phone, website, activities, categories. */
function parseDetail(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1) return null;
  const name = cleanText(h1[1]);
  const locBlock = html.match(/fa-location-dot[\s\S]*?<\/li>/i)?.[0] || '';
  const lines = [...locBlock.matchAll(/<span class="d-block">([\s\S]*?)<\/span>/gi)].map((x) => cleanText(x[1])).filter(Boolean);
  const address = lines.slice(1).join(', ');
  const phone = cleanText(html.match(/fa-phone"><\/i>\s*<span>([^<]*)<\/span>/i)?.[1] || '');
  const website = decodeEntities(html.match(/fa-globe"><\/i>\s*<span>\s*<a href="([^"]+)"/i)?.[1] || '');
  const activities = cleanText(html.match(/<h2>Bedrijfsactiviteiten<\/h2>([\s\S]*?)<\/div>/i)?.[1] || '');
  return {
    name,
    address,
    phone,
    website,
    activities,
    supplier_of: listItems(html, 'Leverancier van:'),
    specialisms: listItems(html, 'Specialiteiten:'),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const start = Date.now();
  try {
    const input = cleanText(String(keyword ?? ''));
    if (!input) return couldnt('other', LIST_URL, 'empty company name');
    const term = stripLegalForm(input) || input;
    const pageUrl = (page) => `${LIST_URL}?_search=${encodeURIComponent(term)}${page > 1 ? `&_paged=${page}` : ''}`;

    const matches = [];
    let page = 1;
    for (;;) {
      const url = pageUrl(page);
      const got = await fetchText(url, start);
      if (got.fail) return couldnt(got.fail, url, got.excerpt);

      const html = got.text;
      // The member list template and its search facet must be on the page, or the layout is not what we expect.
      if (!html.includes('data-name="member"') || !html.includes('facetwp-facet-search')) {
        return couldnt('layout_changed', url, html.slice(0, 300));
      }

      const cards = parseCards(html);
      if (cards.length === 0) {
        if (page === 1) {
          // Normal answer: the search ran and the "no results" block is in the page with zero member cards.
          if (html.includes('js-facetwp-no-results')) {
            return {
              status: 'not_found',
              reason: '',
              records: [],
              source_url: url,
              excerpt: `Member search for "${term}" returned 0 members; no company named "${input}" is listed`,
            };
          }
          return couldnt('layout_changed', url, 'member search page has no member cards and no "no results" block');
        }
        break;
      }

      for (const c of cards) {
        if (sameCompany(c.name, input)) matches.push(c);
      }
      if (matches.length > 0 || cards.length < PAGE_SIZE) break;
      if (page >= MAX_PAGES) {
        return couldnt('other', url, `search "${term}" has more than ${MAX_PAGES * PAGE_SIZE} results; the name was not on the first ${MAX_PAGES} pages`);
      }
      page += 1;
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl(1),
        excerpt: `Member search for "${term}" returned members, but none is named "${input}"`,
      };
    }

    const records = [];
    for (const m of matches.slice(0, MAX_DETAIL)) {
      const got = await fetchText(m.url, start);
      if (got.fail) {
        // The company is on the list; keep that evidence and say the detail page could not be read.
        records.push({ name: m.name, member_page: m.url, detail_error: `${got.fail}: ${got.excerpt}` });
        continue;
      }
      const d = parseDetail(got.text);
      if (!d) {
        records.push({ name: m.name, member_page: m.url, detail_error: 'layout_changed: no company heading on the member page' });
        continue;
      }
      records.push({
        name: d.name,
        member_page: m.url,
        address: d.address,
        phone: d.phone,
        website: d.website,
        activities: d.activities,
        supplier_of: d.supplier_of,
        specialisms: d.specialisms,
      });
    }

    const first = records[0];
    const extra = matches.length > MAX_DETAIL ? `; ${matches.length - MAX_DETAIL} more matches not read` : '';
    return {
      status: 'found',
      reason: '',
      records,
      source_url: matches[0].url,
      excerpt: `Listed as "${first.name}" on the NLdigital member list. ${first.address || ''}${extra}`.trim(),
    };
  } catch (err) {
    return couldnt('other', LIST_URL, 'handler error: ' + String(err?.message || err));
  }
}
