export const meta = { task: 'KR-koreabio.org', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'ceo', 'homepage', 'main_products', 'list'],
  canary: { found: 'CJ바이오사이언스', not_found: '가상바이오테스트주식회사' } };

// KoreaBIO publishes its member companies on one page, /members.php, in two paged lists:
//  - the directory (bcate=&pg=N): company name, CEO, homepage, main products
//  - the name wall (pg2=N, id="corplist"): company name only
// The handler reads every page of both lists and matches the company name after normalising it.
const BASE = 'https://www.koreabio.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const dirUrl = (p) => `${BASE}/members.php?bcate=&pg=${p}`;
const namesUrl = (p) => `${BASE}/members.php?&pg2=${p}`;
const MAX_PAGES = 50;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function clean(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised key: case, punctuation, spaces and the legal form removed (주식회사, Ltd., Inc., ...). */
function keyOf(s) {
  return clean(s).normalize('NFKC').toLowerCase()
    .replace(/주식회사|유한책임회사|유한회사|합자회사|합명회사|\(주\)|\(유\)|\(합\)|㈜/g, ' ')
    .replace(/\b(co|ltd|inc|corp|corporation|limited|llc|company|pte|sdn|bhd)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A listed name matches when the input key equals its full key, its key without brackets, or a bracketed part. */
function keysOf(name) {
  const keys = new Set([keyOf(name), keyOf(name.replace(/\([^)]*\)/g, ' '))]);
  for (const m of name.matchAll(/\(([^)]*)\)/g)) keys.add(keyOf(m[1]));
  return keys;
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: fail('blocked', url, `HTTP ${res.status}`) };
    if (!res.ok) return { fail: fail('http_error', url, `HTTP ${res.status}`) };
    return { html: await res.text() };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: fail(timeout ? 'timeout' : 'other', url, String(e?.message || e)) };
  }
}

/** The two lists on one page: the directory (before id="corplist") and the name wall (from id="corplist"). */
function segments(html) {
  const d = html.indexOf('class="list_wrap"');
  const c = html.indexOf('id="corplist"');
  if (d < 0 || c < 0 || c < d) return null;
  const end = html.indexOf('</ul>', c);
  return { dir: html.slice(d, c), corp: html.slice(c, end < 0 ? html.length : end) };
}

function parseDirectory(part, url) {
  return part.split('<li class="list">').slice(1).map((block) => {
    const name = clean((block.match(/<div class="title">([\s\S]*?)<\/div>/) || [])[1]);
    const info = {};
    for (const m of block.matchAll(/<li><b>([^<]+)<\/b>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/g)) info[clean(m[1])] = clean(m[2]);
    return { name, ceo: info['대표자'] || '', homepage: info['홈페이지'] || '', main_products: info['주요제품'] || '', url };
  }).filter((e) => e.name);
}

function parseNames(part, url) {
  return [...part.matchAll(/<div class="title">([\s\S]*?)<\/div>/g)].map((m) => ({ name: clean(m[1]), url })).filter((e) => e.name);
}

function lastPage(html, re) {
  const nums = [...html.matchAll(re)].map((m) => parseInt(m[1], 10)).filter(Number.isFinite);
  return nums.length ? Math.max(1, ...nums) : 1;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const firstUrl = dirUrl(1);
  try {
    const input = clean(keyword);
    const inputKey = keyOf(input);
    if (!inputKey) return fail('other', firstUrl, 'no company name left to search after removing the legal form');

    // Page 1 first: it tells how many pages each list has.
    const first = await getPage(firstUrl);
    if (first.fail) return first.fail;
    if (!segments(first.html)) return fail('layout_changed', firstUrl, first.html.slice(0, 300));

    // The paging links are built from the current query (e.g. "?bcate=&&pg2=2"), so match the parameter alone.
    const dirLast = lastPage(first.html, /[?&]pg=(\d+)/g);
    const namesLast = lastPage(first.html, /[?&]pg2=(\d+)/g);
    if (dirLast > MAX_PAGES || namesLast > MAX_PAGES) return fail('layout_changed', firstUrl, `paging: ${dirLast} directory pages, ${namesLast} name pages`);

    const rest = [];
    for (let p = 2; p <= dirLast; p++) rest.push({ kind: 'dir', url: dirUrl(p) });
    for (let p = 2; p <= namesLast; p++) rest.push({ kind: 'names', url: namesUrl(p) });
    const fetched = await Promise.all(rest.map((r) => getPage(r.url)));

    const dirEntries = [];
    const nameEntries = [];

    // Page 1: directory from its first list, name wall from its second list.
    const seg1 = segments(first.html);
    dirEntries.push(...parseDirectory(seg1.dir, firstUrl));
    nameEntries.push(...parseNames(seg1.corp, firstUrl));
    if (!dirEntries.length || !nameEntries.length) return fail('layout_changed', firstUrl, 'no entries found on members.php page 1');

    for (let i = 0; i < rest.length; i++) {
      const page = fetched[i];
      if (page.fail) return page.fail;
      const seg = segments(page.html);
      if (!seg) return fail('layout_changed', rest[i].url, page.html.slice(0, 300));
      if (rest[i].kind === 'dir') {
        const entries = parseDirectory(seg.dir, rest[i].url);
        if (!entries.length) return fail('layout_changed', rest[i].url, 'directory page has no entries');
        dirEntries.push(...entries);
      } else {
        const entries = parseNames(seg.corp, rest[i].url);
        if (!entries.length) return fail('layout_changed', rest[i].url, 'name page has no entries');
        nameEntries.push(...entries);
      }
    }

    const dirMatches = dirEntries.filter((e) => keysOf(e.name).has(inputKey));
    const nameMatches = nameEntries.filter((e) => keysOf(e.name).has(inputKey));

    if (dirMatches.length || nameMatches.length) {
      const records = dirMatches.length
        ? dirMatches.map((e) => ({ name: e.name, ceo: e.ceo, homepage: e.homepage, main_products: e.main_products, list: 'directory' }))
        : nameMatches.map((e) => ({ name: e.name, ceo: '', homepage: '', main_products: '', list: 'name list' }));
      const hit = dirMatches[0] || nameMatches[0];
      const r = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: hit.url,
        excerpt: `${r.name} | CEO: ${r.ceo} | ${r.homepage} | ${r.main_products}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `No match for "${input}" on members.php: ${dirEntries.length} directory entries and ${nameEntries.length} name-list entries checked`,
    };
  } catch (err) {
    return fail('other', firstUrl, String(err?.message || err));
  }
}
