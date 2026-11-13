export const meta = { task: 'MY-myfex.kpdn.gov.my', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'registration_no', 'franchisor_type', 'sector', 'address', 'phone', 'valid_from', 'valid_to', 'franchisor_id', 'match_basis'],
  canary: { found: '21 GRILLED', not_found: 'Syarikat Tidak Wujud Sdn Bhd' } };

// MyFEX (KPDN) franchise registry. The public search is a plain GET:
//   https://myfex.kpdn.gov.my/semak?jenama_francais=<text>          (12 cards per page, &page=N for more)
// The registry lists FRANCHISE BRANDS (Jenama Francais), not legal company names, so a "found" means the brand
// name equals the company name after the legal form is removed. Every record says so in match_basis.

const BASE = 'https://myfex.kpdn.gov.my/semak';
const PAGE_SIZE = 12;
const FETCH_TIMEOUT_MS = 25000;
const START_NEW_FETCH_BEFORE_MS = 30000; // never start a new page fetch after 30 s, so the call ends under 60 s
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function decode(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
}

function textOf(html) {
  return decode((html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
}

// Legal form words, removed from the search text and from both names before comparing. "(M)" = Malaysia marker.
const LEGAL_RE = /\b(SDN\.?\s*BHD\.?|SENDIRIAN\s+BERHAD|BERHAD|BHD\.?|SDN\.?|PLT|LLP)(?=\s|$|[.,])/gi;

/** Search text: the keyword without the legal form (the site search is a plain substring match). */
function searchText(keyword) {
  return String(keyword || '')
    .replace(/\(M\)/gi, ' ')
    .replace(LEGAL_RE, ' ')
    .replace(/[.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparison key: upper case, "&" = AND, legal form removed, letters and digits only. */
function nameKey(s) {
  let t = decode(s).toUpperCase().replace(/\(M\)/g, ' ').replace(/&/g, ' AND ');
  t = t.replace(LEGAL_RE, ' ');
  return t.replace(/[^A-Z0-9]/g, '');
}

function layoutOk(html) {
  return html.includes('Menunjukkan') || html.includes('Tiada Rekod Francais');
}

/** Parse one results page into cards. */
function parsePage(html) {
  const plain = textOf(html);
  const countMatch = plain.match(/Menunjukkan\s+(\d+)\s+hingga\s+(\d+)\s+daripada\s+(\d+)/i);
  const empty = /Tiada Rekod Francais/i.test(plain);
  const cards = [];

  // A card's text ends at the next card title, the search modal or the footer.
  const titles = [...html.matchAll(/<h5 class="text-center fw-bold mb-3 text-truncate"([^>]*)>([\s\S]*?)<\/h5>/g)];
  const headers = [...html.matchAll(/card-header[^>]*>\s*([^<]*?)\s*<\/div>/g)];
  const stops = [html.indexOf('<div class="modal fade" id="searchModal"'), html.indexOf('<!-- Footer')].filter((i) => i > 0);

  titles.forEach((m, i) => {
    const start = m.index;
    let end = i + 1 < titles.length ? titles[i + 1].index : html.length;
    for (const s of stops) if (s > start && s < end) end = s;
    const chunk = html.slice(start, end);

    const titleAttr = m[1].match(/title="([^"]*)"/i);
    const name = textOf(titleAttr ? titleAttr[1] : m[2]);
    const sectorHdr = headers.filter((h) => h.index < start).pop();
    const phone = (chunk.match(/<a href="tel:[^"]*"[^>]*>\s*([^<]*?)\s*<\/a>/i) || [])[1] || '';
    const address = textOf((chunk.match(/id="collapseSummary\d+"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
    const type = (chunk.match(/<span class="badge[^"]*">\s*([^<]*?)\s*<\/span>/i) || [])[1] || '';
    const regNo = (chunk.match(/No\. Pendaftaran<\/small><br>\s*<strong>\s*([^<]*?)\s*<\/strong>/i) || [])[1] || '';
    const validFrom = (chunk.match(/Tarikh Sah<\/small><br>\s*([^<\s][^<]*?)\s*</i) || [])[1] || '';
    const validTo = (chunk.match(/Tarikh Tamat<\/small><br>\s*([^<\s][^<]*?)\s*</i) || [])[1] || '';
    const fid = (chunk.match(/name="franchisor_id"\s+value="(\d+)"/i) || [])[1] || '';

    cards.push({
      name,
      registration_no: textOf(regNo),
      franchisor_type: textOf(type),
      sector: sectorHdr ? textOf(sectorHdr[1]) : '',
      address,
      phone: textOf(phone),
      valid_from: textOf(validFrom),
      valid_to: textOf(validTo),
      franchisor_id: fid,
      match_basis: 'brand name (the registry publishes no legal company name)',
    });
  });

  return { cards, total: countMatch ? Number(countMatch[3]) : null, empty, layoutOk: layoutOk(html) };
}

async function getPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ms,en;q=0.8',
        'Connection': 'close',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: timeout ? 'timeout' : 'other', excerpt: timeout ? 'no answer within 25 s' : String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  const html = await res.text();
  if (!layoutOk(html) && /captcha|cf-chl|Just a moment|Attention Required/i.test(html)) {
    return { fail: 'blocked', excerpt: 'bot or captcha page' };
  }
  return { html };
}

/**
 * Read every result page for one search text (stops early when the company is found).
 * Returns { matches, total, scanned, firstUrl, nearNames } or { fail, excerpt, url }.
 */
async function scanSearch(query, key, started) {
  const firstUrl = `${BASE}?jenama_francais=${encodeURIComponent(query)}`;
  const first = await getPage(firstUrl);
  if (first.fail) return { fail: first.fail, excerpt: first.excerpt, url: firstUrl };
  const p1 = parsePage(first.html);
  if (!p1.layoutOk) return { fail: 'layout_changed', excerpt: textOf(first.html).slice(0, 300), url: firstUrl };
  if (p1.total === null) {
    if (p1.empty) return { total: 0, scanned: 0, matches: [], nearNames: [], firstUrl };
    return { fail: 'layout_changed', excerpt: 'result count not found on the page', url: firstUrl };
  }

  const total = p1.total;
  const pages = Math.ceil(total / PAGE_SIZE);
  let cards = p1.cards;
  let matches = cards.filter((c) => key && nameKey(c.name) === key);

  for (let page = 2; matches.length === 0 && page <= pages; page++) {
    if (Date.now() - started > START_NEW_FETCH_BEFORE_MS) {
      return { fail: 'timeout', excerpt: `read ${cards.length} of ${total} results for "${query}" before the time limit`, url: firstUrl };
    }
    const url = `${firstUrl}&page=${page}`;
    const got = await getPage(url);
    if (got.fail) return { fail: got.fail, excerpt: got.excerpt, url };
    const p = parsePage(got.html);
    if (!p.layoutOk || p.cards.length === 0) {
      return { fail: 'layout_changed', excerpt: textOf(got.html).slice(0, 300), url };
    }
    cards = cards.concat(p.cards);
    matches = cards.filter((c) => key && nameKey(c.name) === key);
  }
  return { total, scanned: cards.length, matches, nearNames: cards.slice(0, 3).map((c) => c.name), firstUrl };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const query = searchText(keyword);
    if (!query) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no name left after removing the legal form' };
    }
    const key = nameKey(keyword);

    // The site writes "&" where a name may be typed as "AND" (or the reverse), so try the other form if the first finds nothing.
    const variants = [query];
    if (/&|\bAND\b/i.test(query)) {
      const swapped = /&/.test(query) ? query.replace(/\s*&\s*/g, ' AND ') : query.replace(/\bAND\b/gi, '&');
      if (swapped !== query) variants.push(swapped);
    }

    let last = null;
    for (const q of variants) {
      const r = await scanSearch(q, key, started);
      if (r.fail) return { status: 'couldnt_check', reason: r.fail, records: [], source_url: r.url, excerpt: r.excerpt };
      if (r.matches.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: r.matches,
          source_url: r.firstUrl,
          excerpt: r.matches.map((m) => `${m.name} | ${m.registration_no} | ${m.franchisor_type} | valid ${m.valid_from} to ${m.valid_to}`).join(' || ').slice(0, 500),
        };
      }
      last = { query: q, ...r };
    }

    if (last.total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: last.firstUrl,
               excerpt: `0 franchise records for "${variants.join('" / "')}" (the site says: Tiada Rekod Francais Ditemui)` };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: last.firstUrl,
      excerpt: `${last.total} franchise record(s) came back for "${last.query}" but none has the name "${keyword}". Nearest: ${last.nearNames.join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
