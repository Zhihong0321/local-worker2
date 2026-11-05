// SPAN (Suruhanjaya Perkhidmatan Air Negara) - public supplier/product register.
// The public page https://www.span.gov.my/esure/water/carian_produkA.php
// (embedded in the "Penyenaraian / Pendaftaran Pembekal" page) loads its rows
// from the open JSON endpoint /esure/layout/api_getDataA.php. That endpoint
// accepts POST start/length only (50 rows max, no server-side name filter) and
// returns the rows sorted by supplier name, so we locate a company with a
// binary search over the sorted register instead of downloading all rows.
// Plain HTTP only: no login, no browser, no CAPTCHA.

const API = 'https://www.span.gov.my/esure/layout/api_getDataA.php';
const SOURCE = 'https://www.span.gov.my/esure/water/carian_produkA.php';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE = 50;
const POLITE_MS = 1000;

export const meta = {
  task: 'MY-apps.span.gov.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'roc', 'group', 'category', 'product', 'type', 'brands', 'standard', 'listing', 'valid_until', 'detail_url'],
  canary: { found: 'ABLE STEEL PIPES SDN BHD', not_found: 'O2O Digital' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ordering key matching the register's MySQL collation: uppercase, single
// spaces, punctuation kept (ASCII symbols sort before digits/letters).
function cmpKey(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
}

// Matching key: case and punctuation insensitive.
function norm(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Drop legal-form suffixes so "Dezeno" matches "DEZENO SDN BHD".
function core(s) {
  let n = norm(s);
  let prev;
  do {
    prev = n;
    n = n.replace(/\s+(SDN|SENDIRIAN|BHD|BERHAD|PLT|ENTERPRISE)$/, '').trim();
  } while (n !== prev && n);
  return n;
}

function matches(supplier, keyword) {
  const s = norm(supplier);
  const k = norm(keyword);
  const c = core(keyword);
  if (!c) return false;
  if (s === k || s === c) return true;
  if (s.startsWith(c + ' ')) return true;
  if (k.length >= 4 && s.includes(k)) return true;
  return false;
}

function mapRow(r) {
  return {
    name: String(r.supplier || '').replace(/\s+/g, ' ').trim(),
    roc: r.roc || '',
    group: String(r.group || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim(),
    category: r.category || '',
    product: r.product || '',
    type: r.type || '',
    brands: r.brands || '',
    standard: r.standard || '',
    listing: r.listing || '',
    valid_until: r.end_date || '',
    detail_url: r.guid
      ? 'https://www.span.gov.my/esure/detail_produk.php?guid=' + encodeURIComponent(r.guid)
      : '',
  };
}

let lastAt = 0;
const pageCache = new Map();

async function fetchPage(start) {
  if (pageCache.has(start)) return pageCache.get(start);
  const wait = POLITE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      referer: SOURCE,
    },
    body: 'start=' + encodeURIComponent(start) + '&length=' + PAGE,
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error('http ' + res.status);
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error('not-json');
  }
  if (!j || !Array.isArray(j.data) || typeof j.recordsFiltered !== 'number') {
    throw new Error('shape');
  }
  for (const r of j.data) {
    if (typeof r.supplier !== 'string' || !('listing' in r)) throw new Error('shape-row');
  }
  let rows = j.data;
  if (rows.length > PAGE) rows = rows.slice(0, PAGE);
  const pg = { total: j.recordsFiltered, start, rows };
  pageCache.set(start, pg);
  return pg;
}

function looksSorted(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (cmpKey(rows[i - 1].supplier) > cmpKey(rows[i].supplier)) return false;
  }
  return true;
}

export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  const fail = (reason, msg) => ({
    status: 'couldnt_check',
    reason,
    records: [],
    source_url: SOURCE,
    excerpt: String(msg || '').slice(0, 300),
  });
  if (!kw) return fail('other', 'empty keyword');

  try {
    const firstPage = await fetchPage(0);
    if (firstPage.total === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SOURCE,
        excerpt: 'SPAN product/supplier register returned 0 rows.',
      };
    }
    if (firstPage.rows.length === 0 || !looksSorted(firstPage.rows)) {
      return fail('layout_changed', 'register API no longer returns a supplier-sorted row list');
    }

    const target = cmpKey(kw);
    const N = firstPage.total;

    // Fast path: page 0 is the first 50 rows of the supplier-sorted register, so
    // a keyword that compares <= its last supplier must be answered from it.
    const last0 = firstPage.rows.length ? cmpKey(firstPage.rows[firstPage.rows.length - 1].supplier) : '';
    if (firstPage.rows.length && target <= last0) {
      const fast = [];
      for (const r of firstPage.rows) {
        if (!matches(r.supplier, kw)) continue;
        fast.push(mapRow(r));
      }
      if (fast.length) {
        return {
          status: 'found',
          reason: '',
          records: fast,
          source_url: SOURCE,
          excerpt: fast
            .slice(0, 3)
            .map((r) => `${r.name} (${r.roc}) | ${r.group} | ${r.category} / ${r.product} | ${r.listing} | valid until ${r.valid_until}`)
            .join(' || ')
            .slice(0, 500),
        };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SOURCE,
        excerpt:
          'SPAN water supplier/product register: the supplier list is alphabetical; "' +
          kw +
          '" falls inside the first page (up to ' +
          firstPage.rows[firstPage.rows.length - 1].supplier +
          ') and no supplier matches.',
      };
    }

    let lo = 0;
    let hi = N;
    let bracket = null; // {start, rows}
    let checks = 0;

    while (hi - lo > 0 && checks < 25) {
      checks++;
      const mid = Math.max(0, Math.min(lo + Math.floor((hi - lo) / 2), N - 1));
      const pg = mid === 0 ? firstPage : await fetchPage(mid);
      if (pg.rows.length === 0) {
        hi = mid;
        continue;
      }
      if (mid !== 0 && !looksSorted(pg.rows)) {
        return fail('layout_changed', 'register rows are no longer sorted by supplier name');
      }
      const firstKey = cmpKey(pg.rows[0].supplier);
      const lastKey = cmpKey(pg.rows[pg.rows.length - 1].supplier);
      if (target < firstKey) {
        hi = mid;
      } else if (target > lastKey) {
        lo = mid + pg.rows.length;
      } else {
        bracket = pg;
        break;
      }
    }

    const seen = new Set();
    const found = [];
    const collect = (rows) => {
      for (const r of rows) {
        if (!matches(r.supplier, kw)) continue;
        const rec = mapRow(r);
        const key = rec.name + '|' + rec.listing + '|' + rec.product;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(rec);
      }
    };

    if (bracket) {
      collect(bracket.rows);
      if (found.length === 0 && bracket.start > 0) {
        // A stored name shorter than the keyword (e.g. "ABLE STEEL PIPES" for
        // the keyword "ABLE STEEL PIPES SDN BHD") sorts just before this page.
        collect((await fetchPage(Math.max(0, bracket.start - PAGE))).rows);
      }
    } else {
      const anchor = Math.max(0, Math.min(Math.floor(lo / PAGE) * PAGE, N - 1));
      collect((await fetchPage(anchor)).rows);
      if (found.length === 0 && lo === anchor && anchor > 0) {
        collect((await fetchPage(Math.max(0, anchor - PAGE))).rows);
      }
    }

    if (found.length) {
      const excerpt = found
        .slice(0, 3)
        .map(
          (r) =>
            `${r.name} (${r.roc}) | ${r.group} | ${r.category} / ${r.product} | ${r.listing} | valid until ${r.valid_until}`,
        )
        .join(' || ')
        .slice(0, 500);
      return { status: 'found', reason: '', records: found, source_url: SOURCE, excerpt };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SOURCE,
      excerpt:
        'SPAN water supplier/product register (' +
        N +
        ' rows, sorted by supplier) checked at the alphabetical position of "' +
        kw +
        '": no matching supplier.',
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    let reason = 'other';
    if (/timeout|aborted/i.test(msg)) reason = 'timeout';
    else if (/^http /.test(msg)) reason = 'http_error';
    else if (/shape|not-json/.test(msg)) reason = 'layout_changed';
    return fail(reason, msg);
  }
}
