export const meta = { task: 'PH-pfa.org.ph', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'slug', 'listing_url'],
  canary: { found: 'Alfamart', not_found: 'Tindahan ng Walang Pangalan Kooperatiba' } };

// The PFA members directory is a Wix store gallery: server-rendered HTML, 48 listings per page,
// paged with ?page=N. The site has no working name search (?q= and ?keyword= return the same first page),
// so the handler reads every page of the directory and matches the company name locally.
const LIST = 'https://www.pfa.org.ph/members';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 30;
const LEGAL_END = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
  'llc', 'sdn', 'bhd', 'pte', 'plc', 'opc']);

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

// One comparison key for a name: case, punctuation, spacing and a trailing legal form are ignored.
function keyOf(text) {
  const t = String(text).toLowerCase().replace(/&/g, ' and ').replace(/['’‘`´]/g, '').replace(/[^a-z0-9ñ]+/g, ' ');
  const toks = t.split(' ').filter(Boolean);
  if (toks[0] === 'the') toks.shift();
  while (toks.length && LEGAL_END.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

// Candidate keys for a name: the main name, and anything written in brackets (an alternative trading name).
function keysFor(name) {
  const main = name.replace(/\([^)]*\)/g, ' ');
  const brackets = [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  return [keyOf(main), ...brackets.map(keyOf)].filter(Boolean);
}

function parseItems(html) {
  const items = [];
  for (const chunk of html.split('data-hook="product-list-grid-item"').slice(1)) {
    const name = chunk.match(/data-hook="product-item-name">([^<]*)</);
    const slug = chunk.match(/data-slug="([^"]+)"/);
    if (name && slug) items.push({ name: decode(name[1]), slug: slug[1] });
  }
  return items;
}

function pageUrl(n) {
  return n === 1 ? LIST : `${LIST}?page=${n}`;
}

// Fetches one directory page. Returns { ok: true, items, total, url } or { ok: false, reason, url, excerpt }.
async function getPage(n) {
  const url = pageUrl(n);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'timeout' : 'other', url, excerpt: String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
  }
  const html = await res.text();
  const items = parseItems(html);
  if (!items.length) {
    const total = html.match(/"totalCount":(\d+)/);
    const walled = /captcha|just a moment|cf-chl|access denied/i.test(html) && !html.includes('product-list-wrapper');
    return {
      ok: false, reason: walled ? 'blocked' : 'layout_changed', url,
      excerpt: (total ? `totalCount ${total[1]}; ` : '') + 'no directory listings found on the page',
    };
  }
  const total = html.match(/"totalCount":(\d+)/);
  return { ok: true, items, total: total ? Number(total[1]) : null, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = keysFor(decode(keyword));
    if (!wanted.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST, excerpt: 'the name has no usable words to compare' };
    }

    const first = await getPage(1);
    if (!first.ok) {
      return { status: 'couldnt_check', reason: first.reason, records: [], source_url: first.url, excerpt: first.excerpt };
    }

    // Read the rest of the directory: total listings from the first page, listings per page from the same page.
    const perPage = first.items.length;
    const total = first.total;
    if (!total || total < perPage || total > perPage * MAX_PAGES) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST,
        excerpt: `unexpected listing count (${total}) for ${perPage} per page` };
    }
    const pageCount = Math.ceil(total / perPage);
    const rest = [];
    for (let n = 2; n <= pageCount; n++) rest.push(getPage(n));
    const pages = [first, ...(await Promise.all(rest))];

    const bad = pages.find((p) => !p.ok);
    if (bad) {
      return { status: 'couldnt_check', reason: bad.reason, records: [], source_url: bad.url, excerpt: bad.excerpt };
    }

    // Collect every listing (a listing appears once per page it sits on; de-duplicate by slug).
    const seen = new Map();
    for (const p of pages) {
      for (const it of p.items) {
        if (!seen.has(it.slug)) seen.set(it.slug, { ...it, page: p.url });
      }
    }
    if (seen.size < total) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST,
        excerpt: `read ${seen.size} of ${total} listings; cannot prove the company is absent` };
    }

    const want = new Set(wanted);
    const matches = [...seen.values()].filter((it) => keysFor(it.name).some((k) => want.has(k)));

    if (!matches.length) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST,
        excerpt: `checked all ${total} listings on the PFA members directory (${pageCount} pages); no match` };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({
        name: m.name,
        slug: m.slug,
        listing_url: `https://www.pfa.org.ph/product-page/${m.slug}`,
      })),
      source_url: matches[0].page,
      excerpt: `PFA members directory lists: ${matches.map((m) => m.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LIST,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
