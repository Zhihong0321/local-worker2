export const meta = {
  task: 'VN-vla.com.vn',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'english_name', 'address', 'website', 'membership', 'joined'],
  canary: { found: 'CÔNG TY TNHH BALANCE TRANS', not_found: 'CÔNG TY TNHH XYZ KHÔNG TỒN TẠI' },
};

const BASE = 'https://vla.com.vn/danh-ba-hoi-vien/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_PAGES = 6;          // result pages read per query
const START_LIMIT_MS = 30000; // no new page is started after 30 s, so every call ends well under 60 s

// Legal-form words, folded (no accents, lower case). Removed before comparing names.
const LEGAL_PHRASES = [
  'doanh nghiep tu nhan', 'mot thanh vien', 'co phan', 'cong ty', 'pte ltd', 'pvt ltd', 'sdn bhd', 'co ltd',
  'tnhh', 'cty', 'mtv', 'dntn', 'hop danh', 'ltd', 'limited', 'llc', 'jsc', 'corp', 'inc', 'company', 'gmbh',
  'plc', 'co', 'cp', 'ct', 'sa',
];

/** Lower case, no accents (đ -> d), punctuation to spaces, single spaces. */
function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The folded name without legal-form words. */
function core(s) {
  let t = ' ' + fold(s) + ' ';
  for (const p of LEGAL_PHRASES) {
    while (t.includes(' ' + p + ' ')) t = t.replace(' ' + p + ' ', ' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Comparison key: core name with spaces removed; falls back to the folded name if nothing is left. */
function key(s) {
  return (core(s) || fold(s)).replace(/ /g, '');
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&#038;|&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Read one result page. Returns { cards, hasNext, url } or { failure }. */
async function readPage(query, page) {
  const url = new URL(page === 1 ? BASE : `${BASE}page/${page}/`);
  url.searchParams.set('keyword', query);
  const href = url.href;
  let res;
  try {
    res = await fetch(href, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'vi,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { failure: fail(timedOut ? 'timeout' : 'other', href, String(err?.message || err)) };
  }
  if (res.status === 403 || res.status === 429) return { failure: fail('blocked', href, `HTTP ${res.status}`) };
  if (!res.ok) return { failure: fail('http_error', href, `HTTP ${res.status}`) };

  const html = await res.text();

  // A normal answer (with or without hits) always has the search form and the result box.
  if (!html.includes('class="filter_hv"') || !html.includes('class="search_result"')) {
    if (/cf-chl|challenge-platform|Just a moment\.\.\.|cf_chl_opt/i.test(html)) {
      return { failure: fail('blocked', href, 'bot check page') };
    }
    return { failure: fail('layout_changed', href, html.replace(/\s+/g, ' ').slice(0, 300)) };
  }

  const cards = [];
  const chunks = html.split(/<div id="member-id-/).slice(1);
  for (const chunk of chunks) {
    const pick = (re) => { const m = chunk.match(re); return m ? cleanText(m[1]) : ''; };
    const card = {
      name: pick(/<h4>([\s\S]*?)<\/h4>/),
      english_name: pick(/<h5>([\s\S]*?)<\/h5>/),
      address: pick(/<p class="address">([\s\S]*?)<\/p>/),
      website: pick(/<p class="website">([\s\S]*?)<\/p>/),
      membership: pick(/<p class="member-type">([\s\S]*?)<\/p>/),
      joined: pick(/<p class="created-date">([\s\S]*?)<\/p>/),
    };
    if (!card.name && !card.english_name) {
      return { failure: fail('layout_changed', href, chunk.replace(/\s+/g, ' ').slice(0, 300)) };
    }
    cards.push(card);
  }
  return { cards, hasNext: /class="next page-numbers"/.test(html), url: href };
}

/** Read every result page of one query, keeping the cards whose name matches the company. */
async function scan(query, wantKey, started) {
  const matches = [];
  let total = 0;
  let url = '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() - started > START_LIMIT_MS) {
      return { failure: fail('timeout', url || BASE, 'time budget used up before every result page was read') };
    }
    const got = await readPage(query, page);
    if (got.failure) return { failure: got.failure };
    url = got.url;
    total += got.cards.length;
    for (const c of got.cards) {
      if (key(c.name) === wantKey || key(c.english_name) === wantKey) matches.push(c);
    }
    if (!got.hasNext) return { matches, total, url, complete: true };
  }
  return { matches, total, url, complete: false };
}

function toFound(scanned, keyword) {
  return {
    status: 'found',
    reason: '',
    records: scanned.matches,
    source_url: scanned.url,
    excerpt: scanned.matches.map((c) => `${c.name} | ${c.english_name} | ${c.address}`).join(' || ').slice(0, 300),
  };
}

/** Look one company up in the VLA member directory. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return fail('other', BASE, 'empty company name');

    const wantKey = key(kw);
    if (!wantKey) return fail('other', BASE, 'company name has no usable letters');

    // The site search is accent-insensitive and matches the Vietnamese name, so search the core name.
    const queryA = core(kw) || fold(kw);
    const a = await scan(queryA, wantKey, started);
    if (a.failure) return a.failure;
    if (a.matches.length) return toFound(a, kw);
    if (!a.complete) return fail('other', a.url, `too many results for "${queryA}" to check every page`);

    // The site search does not look at the English name. If nothing came back, try the longest word of the name.
    const words = queryA.split(' ').filter(Boolean);
    if (a.total === 0 && words.length >= 2) {
      const queryB = words.reduce((x, y) => (y.length > x.length ? y : x));
      const b = await scan(queryB, wantKey, started);
      if (b.failure) return b.failure;
      if (b.matches.length) return toFound(b, kw);
      if (!b.complete) return fail('other', b.url, `too many results for "${queryB}" to check every page`);
      return { status: 'not_found', reason: '', records: [], source_url: b.url,
        excerpt: `0 directory entries for "${queryA}" or "${queryB}"` };
    }

    return { status: 'not_found', reason: '', records: [], source_url: a.url,
      excerpt: `0 directory entries matching "${kw}" (searched "${queryA}")` };
  } catch (err) {
    return fail('other', BASE, String(err?.message || err));
  }
}
