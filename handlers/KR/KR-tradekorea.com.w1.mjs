export const meta = {
  task: 'KR-tradekorea.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'businessno', 'country', 'category', 'president', 'address', 'year_established', 'employees', 'product_category', 'verified_certificate', 'main_markets', 'detail_url', 'detail_error'],
  canary: { found: 'Cross Fin Trade LTD', not_found: '가나다무역유한회사' },
};

// TradeKorea company search: GET /companies/<base64url(search text)>.html lists the companies whose name matches.
// Each company row links to /companies/detail.do?businessno=N, which shows country, product category, etc.
const BASE = 'https://www.tradekorea.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;      // the site shows 20 companies per page (search_startCount steps)
const MAX_PAGES = 5;       // at most 100 companies read per keyword
const BUDGET_MS = 30000;   // no new page or detail fetch after 30 s; one fetch takes at most 25 s, so the call ends by ~55 s

// Legal-form words that are dropped before comparing names (and before searching).
const LEGAL = new Set([
  'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'plc',
  'pte', 'pvt', 'private', 'sdn', 'bhd', 'gmbh', 'ag', 'bv', 'sa', 'srl', 'kk', 'jsc', 'pt', 'the',
  '주식회사', '유한회사', '주', '유한', '회사',
]);

function tokens(str) {
  return String(str || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Name without legal form, lowercase, punctuation removed (e.g. "SAMSUNG ELECTRONICS CO., LTD." -> "samsung electronics"). */
function coreName(str) {
  return tokens(str).filter((t) => !LEGAL.has(t)).join(' ');
}

/** Comparison key: core name with spaces removed, so "Cross Fin" and "CrossFin" compare equal. */
function matchKey(str) {
  return coreName(str).replace(/ /g, '');
}

/** The search text sent to the site: the typed name with legal-form words removed, original spelling kept. */
function searchText(keyword) {
  const words = String(keyword || '').replace(/[,.()]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !LEGAL.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
  return (kept.length ? kept.join(' ') : String(keyword || '').trim());
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function plain(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' '));
}

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  const text = await res.text();
  return { status: res.status, text, finalUrl: res.url || url };
}

/** Maps a non-200 answer or a block page to couldnt_check. Returns null when the page is usable. */
function badPage(r, url) {
  if (r.status === 403 || r.status === 429) return { reason: 'blocked', excerpt: `HTTP ${r.status}` };
  if (/\/membership\/login|captcha|access denied|attention required/i.test(r.finalUrl + ' ' + r.text.slice(0, 4000))) {
    return { reason: 'blocked', excerpt: 'login, captcha or bot wall at ' + r.finalUrl };
  }
  if (r.status !== 200) return { reason: 'http_error', excerpt: `HTTP ${r.status} at ${url}` };
  return null;
}

/** Reads one page of the company list. */
function parseList(html) {
  const items = [];
  const re = /<a href="\/companies\/detail\.do\?businessno=(\d+)"[^>]*class="item_name"[^>]*>([\s\S]*?)<\/a>/g;
  const found = [];
  let m;
  while ((m = re.exec(html)) !== null) found.push({ businessno: m[1], nameHtml: m[2], index: m.index, end: re.lastIndex });
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    const segEnd = i + 1 < found.length ? found[i + 1].index : f.end + 3000;
    const seg = html.slice(f.end, Math.min(segEnd, f.end + 3000));
    const flag = seg.match(/class="flag_name">([\s\S]*?)<\/span>/);
    const cat = seg.match(/class="brandname"[\s\S]*?<span>([\s\S]*?)<\/span>/);
    items.push({
      businessno: f.businessno,
      name: plain(f.nameHtml),
      country: flag ? plain(flag[1]) : '',
      category: cat ? plain(cat[1]) : '',
    });
  }
  const tot = html.match(/Companies\((\d+)\)/);
  const noData = /searchNoData/.test(html) || /did not match any/i.test(html);
  return { items, total: tot ? Number(tot[1]) : null, noData };
}

// Labels a company detail page can show. Pages differ: some have Product Category / Verified Certificate, some
// have Address / Year Established instead, so each label is read on its own up to the next label.
const DETAIL_LABELS = ['Country', 'President', 'Address', 'Year Established', 'No. of Total Employees',
  'Product Category', 'Verified Certificate', 'Main Markets', 'Main Product', 'Company introduction'];
const LABEL_RE = new RegExp('(?:' + DETAIL_LABELS.map((l) => l.replace(/\./g, '\\.')).join('|') + ')(?= )', 'g');

/** Reads one company detail page. */
function parseDetail(html) {
  const text = plain(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const value = (label) => {
    const at = text.indexOf(label + ' ');
    if (at < 0) return '';
    const from = at + label.length;
    LABEL_RE.lastIndex = from;
    const next = LABEL_RE.exec(text);
    return text.slice(from, next ? next.index : Math.min(text.length, from + 300)).trim();
  };
  const out = {
    country: value('Country'),
    president: value('President'),
    address: value('Address'),
    year_established: value('Year Established'),
    employees: value('No. of Total Employees'),
    product_category: value('Product Category'),
    verified_certificate: value('Verified Certificate'),
    main_markets: [],
    ok: text.includes('Country '),
  };
  const mk = html.match(/Main Markets([\s\S]*?)(?:Main Product|Company introduction|<\/section>|<\/div>\s*<\/div>)/);
  if (mk) {
    const titles = [...mk[1].matchAll(/title="([^"]+)"/g)].map((x) => decode(x[1]));
    out.main_markets = [...new Set(titles)];
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const key = matchKey(keyword);
  const term = searchText(keyword);
  const base = `${BASE}/companies/${b64url(term)}.html`;
  try {
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: base, excerpt: 'no usable letters in the company name' };
    }

    const matches = [];
    const seen = new Set();
    let total = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = page === 0 ? base : `${base}?search_startCount=${page * PAGE_SIZE}`;
      if (page > 0 && Date.now() - started > BUDGET_MS) {
        if (matches.length) break; // exact matches already proven; the rest could not be read in time
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: base, excerpt: `page ${page + 1} not read: time budget used` };
      }
      const r = await get(url);
      const bad = badPage(r, url);
      if (bad) return { status: 'couldnt_check', reason: bad.reason, records: [], source_url: url, excerpt: bad.excerpt };

      const parsed = parseList(r.text);
      if (total === null) total = parsed.total;

      if (parsed.items.length === 0) {
        if (page === 0 && !parsed.noData && total !== 0) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: plain(r.text).slice(0, 300) };
        }
        break; // empty result page (or end of list)
      }

      for (const it of parsed.items) {
        if (seen.has(it.businessno)) continue;
        seen.add(it.businessno);
        if (matchKey(it.name) === key) matches.push(it);
      }
      if (total !== null && seen.size >= total) break;
    }

    if (matches.length === 0) {
      // not_found only when every result was read; a capped read cannot prove the company is absent.
      if (total !== null && seen.size < total) {
        return {
          status: 'couldnt_check',
          reason: 'other',
          records: [],
          source_url: base,
          excerpt: `TradeKorea company search for "${term}" has ${total} results; read ${seen.size}, no exact name match in what was read`,
        };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: base,
        excerpt: `TradeKorea company search for "${term}": ${total ?? 0} company result(s), none with the name "${keyword}"`,
      };
    }

    const records = [];
    for (const mt of matches) {
      const detailUrl = `${BASE}/companies/detail.do?businessno=${mt.businessno}`;
      const rec = {
        name: mt.name,
        businessno: mt.businessno,
        country: mt.country,
        category: mt.category,
        president: '',
        address: '',
        year_established: '',
        employees: '',
        product_category: '',
        verified_certificate: '',
        main_markets: [],
        detail_url: detailUrl,
        detail_error: '',
      };
      if (Date.now() - started > BUDGET_MS) {
        rec.detail_error = 'timeout: detail not read';
      } else {
        try {
          const d = await get(detailUrl);
          const bad = badPage(d, detailUrl);
          if (bad) {
            rec.detail_error = `${bad.reason}: ${bad.excerpt}`;
          } else {
            const info = parseDetail(d.text);
            if (info.ok) {
              rec.country = info.country || rec.country;
              rec.president = info.president;
              rec.address = info.address;
              rec.year_established = info.year_established;
              rec.employees = info.employees;
              rec.product_category = info.product_category;
              rec.verified_certificate = info.verified_certificate;
            } else {
              rec.detail_error = 'layout_changed: detail fields not found';
            }
            rec.main_markets = info.main_markets;
          }
        } catch (err) {
          rec.detail_error = 'other: ' + String(err?.message || err).slice(0, 200);
        }
      }
      records.push(rec);
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].detail_url,
      excerpt: `TradeKorea: ${records.length} exact name match(es) among ${total ?? '?'} company result(s). ${records[0].name} | ${records[0].country} | ${records[0].category}`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: base, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
