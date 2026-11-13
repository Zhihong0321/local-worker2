export const meta = { task: 'NZ-whariki.co.nz', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'url', 'category', 'suburb', 'region'],
  canary: { found: 'Next Level Scaffold', not_found: 'Te Whare Kōrero Pakihi Kōwhai Limited' } };

// The Whariki Maori Business Directory lists every business on server-rendered pages (100 per page, 15 pages,
// about 1,435 entries). Walk the pages, then match the company name exactly after normalising it.
const BASE = 'https://www.whariki.co.nz/maori-business-directory';
const PAGE_PARAM = 'a74db47c_page';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 30;
const DEADLINE_MS = 30000; // stop starting new page requests after 30 s; each request has its own 25 s timeout

// Legal-form words dropped from the end of a name on both sides before comparing.
const LEGAL = new Set(['ltd', 'limited', 'llc', 'inc', 'incorporated', 'company', 'co']);

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower case, no macrons or apostrophes, '&' = 'and', punctuation dropped, legal form dropped. */
function normalize(s) {
  const t = decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['‘’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = t ? t.split(' ') : [];
  while (tokens.length && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function pageUrl(n) {
  return `${BASE}?${PAGE_PARAM}=${n}`;
}

function parseItems(html) {
  const items = [];
  for (const chunk of html.split('product-list-view-list w-dyn-item').slice(1)) {
    const link = chunk.match(/<a href="\/directory-businesses\/([^"?#]+)" class="product-list-link">([\s\S]*?)<\/a>/);
    if (!link) continue;
    const pick = (re) => { const m = chunk.match(re); return m ? cleanText(m[1]) : ''; };
    items.push({
      name: cleanText(link[2]),
      url: new URL('/directory-businesses/' + link[1], 'https://www.whariki.co.nz').href,
      category: pick(/<div class="price-regular">([\s\S]*?)<\/div>/),
      suburb: pick(/<div class="detail-11-copy">([\s\S]*?)<\/div>/),
      region: pick(/<div class="detail-11">([\s\S]*?)<\/div>/),
    });
  }
  return items;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const wanted = normalize(keyword);
    if (!wanted) return couldnt('other', BASE, 'empty company name');

    const seen = new Set();
    const all = []; // { ...item, page }
    let pagesRead = 0;

    for (let n = 1; ; n++) {
      if (n > MAX_PAGES) return couldnt('layout_changed', pageUrl(n), 'more than 30 listing pages; pagination not understood');
      if (Date.now() - started > DEADLINE_MS) return couldnt('timeout', pageUrl(n), 'the directory list did not finish within 30 s');

      let res;
      try {
        res = await fetch(pageUrl(n), {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        const timed = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return couldnt(timed ? 'timeout' : 'other', pageUrl(n), String(err?.message || err));
      }
      if (res.status === 403 || res.status === 429) return couldnt('blocked', pageUrl(n), `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', pageUrl(n), `HTTP ${res.status}`);

      const html = await res.text();
      const items = parseItems(html);
      pagesRead++;

      if (items.length === 0) {
        if (n === 1) {
          const challenge = /just a moment|cf-chl|captcha|turnstile/i.test(html) && !/product-list-link/.test(html);
          return couldnt(challenge ? 'blocked' : 'layout_changed', pageUrl(n), challenge ? 'bot check page' : html.slice(0, 300));
        }
        break; // past the last page
      }

      let added = 0;
      for (const it of items) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        added++;
        all.push({ ...it, page: pageUrl(n) });
      }
      if (added === 0) break; // the site repeated a page: nothing new, stop
    }

    const matches = all.filter((it) => normalize(it.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE,
        excerpt: `No listed business has the name "${keyword}" (checked ${all.length} listings on ${pagesRead} pages)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({ name: m.name, url: m.url, category: m.category, suburb: m.suburb, region: m.region })),
      source_url: matches[0].page,
      excerpt: matches.map((m) => [m.name, m.category, m.suburb, m.region].filter(Boolean).join(' | ')).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    return couldnt('other', BASE, String(err?.message || err));
  }
}
