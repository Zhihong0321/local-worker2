export const meta = {
  task: 'CH-search.ch',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'postal_code', 'locality', 'region', 'phone', 'categories', 'occupation', 'detail_url'],
  canary: { found: 'Nestlé Suisse SA', not_found: 'Zyxqwvbrnt Handels GmbH' },
};

const BASE = 'https://search.ch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-CH,de;q=0.9,fr;q=0.8,en;q=0.7',
};
const PAGE_SIZE = 10;   // the site lists 10 entries per page
const MAX_PAGES = 10;   // at most 100 entries are read for one name

// Legal forms (DE / FR / IT / EN). Removed only at the start or end of a name, so both sides compare the same core name.
const LEGAL = new Set([
  'sa', 'ag', 'gmbh', 'sarl', 'sagl', 'rl', 'srl', 'spa', 'ltd', 'llc', 'inc', 'co', 'kg', 'kgaa', 'cie',
  'societe', 'anonyme', 'societa', 'anonima', 'aktiengesellschaft', 'gesellschaft', 'mit', 'beschrankter',
  'haftung', 'genossenschaft',
]);

function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/ß/g, 'ss')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function core(s) {
  const t = fold(s).split(' ').filter(Boolean);
  while (t.length && LEGAL.has(t[0])) t.shift();
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.length ? t.join(' ') : fold(s);
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function text(html) {
  // Inline tags (the site wraps the searched word in <span class="sl-keyword">) are dropped without a space,
  // so "Nestlé <span>S</span>uisse" stays "Nestlé Suisse". Other tags become a space.
  const noInline = String(html || '').replace(/<\/?(?:span|b|i|em|strong|small|a|abbr|font|u)\b[^>]*>/gi, '');
  return decode(noInline.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Some entries print a phone number after the name ("Birseck Sanitär GmbH Tel: 076 425 95 80"). Remove that tail.
function cleanName(s) {
  return s.replace(/[,\s]*\b(?:t[ée]l|natel|mobile)\.?:?\s*\+?[\d()\s/.-]{6,}.*$/i, '').trim();
}

function parseEntries(html) {
  const out = [];
  for (const raw of html.split('<article').slice(1)) {
    const chunk = raw.split('</article>')[0];
    if (!chunk.includes('tel-resultentry')) continue;
    const h1 = chunk.match(/<h1[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!h1) continue;
    const addr = chunk.match(/<div class="tel-address">([\s\S]*?)<\/div>/i);
    const zip = chunk.match(/<span class="postal-code">([\s\S]*?)<\/span>/i);
    const loc = chunk.match(/<span class="locality">([\s\S]*?)<\/span>/i);
    const reg = chunk.match(/<span class="region">([\s\S]*?)<\/span>/i);
    const tel = chunk.match(/href="tel:([^"]+)"/i);
    const cat = chunk.match(/<div class="tel-categories">([\s\S]*?)<\/div>/i);
    const occ = chunk.match(/<div class="tel-occupation">([\s\S]*?)<\/div>/i);
    out.push({
      name: cleanName(text(h1[2])),
      address: addr ? text(addr[1]) : '',
      postal_code: zip ? text(zip[1]) : '',
      locality: loc ? text(loc[1]) : '',
      region: reg ? text(reg[1]) : '',
      phone: tel ? decode(tel[1]).trim() : '',
      categories: cat ? text(cat[1]) : '',
      occupation: occ ? text(occ[1]) : '',
      detail_url: new URL(decode(h1[1]), BASE).href,
    });
  }
  return out;
}

function countOf(html) {
  const m = html.match(/tel-result-count">\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

async function getPage(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  const body = await res.text();
  return { res, body, finalUrl: res.url || url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const searchUrl = (pages) => `${BASE}/tel/?was=${encodeURIComponent(name)}${pages > 1 ? `&pages=${pages}` : ''}`;
  const src1 = searchUrl(1);
  try {
    if (!name) return couldnt('other', src1, 'empty company name');
    const want = core(name);
    if (!want) return couldnt('other', src1, 'company name has no usable words');

    const first = await getPage(src1);
    const { res, body } = first;
    if (res.status === 403 || res.status === 429 || res.headers.get('x-amzn-waf-action')) {
      return couldnt('blocked', src1, `HTTP ${res.status}`);
    }
    if (new URL(first.finalUrl).hostname.startsWith('login.')) {
      return couldnt('blocked', src1, `redirected to login: ${first.finalUrl}`);
    }

    const total = countOf(body);
    if (total === null) {
      // The results counter is missing: either a bot check, or a page we do not know.
      if (body.length < 30000 && /captcha|challenge|access denied|are you a robot/i.test(body)) {
        return couldnt('blocked', src1, `HTTP ${res.status}: bot or captcha check`);
      }
      if (!res.ok) return couldnt('http_error', src1, `HTTP ${res.status}`);
      return couldnt('layout_changed', src1, body.slice(0, 300));
    }
    // A search with no hits answers HTTP 404 with a counter of 0 (checked live). Any other error is a real error.
    if (!res.ok && !(res.status === 404 && total === 0)) {
      return couldnt('http_error', src1, `HTTP ${res.status}`);
    }

    const isMatch = (e) => core(e.name) === want;
    let entries = parseEntries(body);
    let matches = entries.filter(isMatch);
    let usedUrl = src1;
    let excerptTotal = total;

    if (!matches.length && total > entries.length) {
      // Not on page 1: the site's pages= parameter shows the first N pages in one request.
      const needed = Math.ceil(total / PAGE_SIZE);
      const pages = Math.min(needed, MAX_PAGES);
      usedUrl = searchUrl(pages);
      const more = await getPage(usedUrl);
      if (more.res.status === 403 || more.res.status === 429 || more.res.headers.get('x-amzn-waf-action')) {
        return couldnt('blocked', usedUrl, `HTTP ${more.res.status}`);
      }
      if (!more.res.ok) return couldnt('http_error', usedUrl, `HTTP ${more.res.status}`);
      const moreTotal = countOf(more.body);
      if (moreTotal === null) return couldnt('layout_changed', usedUrl, more.body.slice(0, 300));
      const seen = new Set();
      entries = parseEntries(more.body).filter((e) => (seen.has(e.detail_url) ? false : seen.add(e.detail_url)));
      matches = entries.filter(isMatch);
      excerptTotal = moreTotal;
      if (!matches.length && moreTotal > entries.length && moreTotal > pages * PAGE_SIZE) {
        // More results than we read: the answer is not known, so it is not "not_found".
        return couldnt('other', usedUrl, `${moreTotal} results for "${name}", read ${entries.length}; company not among them`);
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: usedUrl,
        excerpt: `${matches.length} matching entr${matches.length === 1 ? 'y' : 'ies'} for "${name}" on search.ch: ` +
          matches.map((m) => `${m.name}, ${m.address}, ${m.phone}`).join(' | '),
      };
    }

    const noHits = /Keine Einträge[^<"]*/.exec(body);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: usedUrl,
      excerpt: noHits ? noHits[0].trim() : `${excerptTotal} results for "${name}", none with this company name`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', src1, String(err?.message || err));
  }
}
