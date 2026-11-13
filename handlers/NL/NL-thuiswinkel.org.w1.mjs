export const meta = { task: 'NL-thuiswinkel.org', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'kvk', 'address', 'website', 'certificate', 'certificate_status', 'profile_url'],
  canary: { found: '123 3D B.V.', not_found: 'Onbekende Webwinkel Zzq B.V.' } };

const BASE = 'https://www.thuiswinkel.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 4;        // result pages read per lookup (the site shows about 24 members per page)
const MAX_DETAILS = 3;      // detail pages read per lookup
const BUDGET_MS = 28000;    // no new fetch starts after 28 s; the last one ends by 53 s, before the 60 s limit
const LEGAL = new Set(['bv', 'nv', 'vof', 'cv', 'bvba', 'eenmanszaak', 'ltd', 'gmbh']);

/** Letters and digits only, accents removed, dots dropped (so "B.V." becomes "bv"). */
function words(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\./g, '')
    .split(/[^A-Za-z0-9]+/).filter(Boolean);
}
/** Name words without the legal form. */
function coreWords(s) {
  return words(s).filter((w) => !LEGAL.has(w.toLowerCase()));
}
/** Comparison key: case, punctuation, spaces and legal form ignored. */
function key(s) {
  return coreWords(s).join('').toLowerCase();
}
function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function text(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

/** Returns a couldnt_check answer when the response is a refusal or an error, otherwise null. */
function refusal(r, url) {
  if (r.status === 403 || r.status === 429 || /cf-chl|challenge-platform|g-recaptcha|h-captcha|Just a moment\.\.\./i.test(r.body)) {
    return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${r.status}` };
  }
  if (!r.ok) {
    return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${r.status}` };
  }
  return null;
}

/** "N leden gevonden" (or "1 lid gevonden") from the results heading, or null if the heading is missing. */
function countOf(html) {
  const m = html.match(/aria-live="polite"[^>]*>\s*(\d+)\s+(?:leden|lid)\s+gevonden/i);
  return m ? Number(m[1]) : null;
}

/** One entry per member card in the results list. */
function parseCards(html) {
  const area = html.slice(Math.max(0, html.indexOf('id="results"')));
  const re = /<h3[^>]*>\s*<a[^>]*href="(\/leden[^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/gi;
  const hits = [];
  let m;
  while ((m = re.exec(area))) hits.push({ href: m[1], name: text(m[2]), index: m.index });
  return hits.map((h) => {
    const end = area.indexOf('</li>', h.index);
    const seg = area.slice(h.index, end > h.index ? end : h.index + 2000);
    const certs = [...seg.matchAll(/<img[^>]*alt="(Thuiswinkel [^"]+)"/gi)].map((c) => decode(c[1]));
    const status = seg.match(/<span class="font-bold">([^<]+)<\/span>/i);
    return {
      name: h.name,
      href: h.href,
      certificate: [...new Set(certs)].join('; '),
      certificate_status: status ? text(status[1]) : '',
    };
  });
}

function isMatch(cardName, wanted) {
  const full = key(cardName);
  const beforeVia = key(cardName.replace(/\s+via\s+.*$/i, '')); // "18toys via bol.com" is the shop of 18toys
  return full === wanted || beforeVia === wanted;
}

/** Adds KvK, address and website from the member's detail page. */
function addDetail(html, rec) {
  const kvk = html.match(/sr-only">KvK<\/span>[\s\S]*?<div class="flex-1">\s*KvK\s*([\d ]+)/i);
  if (kvk) rec.kvk = kvk[1].replace(/\s/g, '');
  const addr = html.match(/sr-only">Vestigingsadres<\/span>[\s\S]*?<div class="flex-1">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
  if (addr) rec.address = text(addr[1]);
  const web = html.match(/sr-only">Website URL<\/span>[\s\S]*?href="([^"]+)"/i);
  if (web) rec.website = decode(web[1]);
  return rec;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows, Node aborts (exit 127, libuv assertion) when the process exits right after a fetch.
  // A short pause before the answer is returned lets the socket settle. Costs 1.5 s per call.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  const wanted = key(input);
  const term = coreWords(input).join(' ') || input;
  const searchUrl = (page) => `${BASE}/ledenlijst-zoeken/?Keyword=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`;
  const sourceUrl = searchUrl(1);
  const timeLeft = () => Date.now() - started < BUDGET_MS;

  try {
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'no company name given' };
    }

    // Page 1 of the member search
    const first = await get(sourceUrl);
    const refused1 = refusal(first, sourceUrl);
    if (refused1) return refused1;

    const total = countOf(first.body);
    if (total === null) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: text(first.body).slice(0, 300) };
    }
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: `0 leden gevonden for "${term}"` };
    }

    let cards = parseCards(first.body);
    const templates = (first.body.match(/data-template="webshop"/g) || []).length;
    if (cards.length === 0 || templates !== cards.length) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl,
        excerpt: `${total} results shown, ${cards.length} cards read, ${templates} card markers` };
    }

    // Further result pages, if the search has more than one page of members
    const pages = Math.ceil(total / cards.length);
    let incomplete = false;
    for (let p = 2; p <= pages; p++) {
      if (p > MAX_PAGES) { incomplete = true; break; }
      if (!timeLeft()) {
        if (cards.some((c) => isMatch(c.name, wanted))) { incomplete = true; break; }
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl(p), excerpt: 'time budget used before all result pages were read' };
      }
      const r = await get(searchUrl(p));
      const refused2 = refusal(r, searchUrl(p));
      if (refused2) return refused2;
      cards = cards.concat(parseCards(r.body));
    }

    const matches = [];
    const seen = new Set();
    for (const c of cards) {
      if (isMatch(c.name, wanted) && !seen.has(c.href)) { seen.add(c.href); matches.push(c); }
    }

    if (matches.length === 0) {
      if (incomplete) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
          excerpt: `${total} results for "${term}", more pages than the ${MAX_PAGES} read; no match yet` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `${total} result(s) for "${term}", none with this company name` };
    }

    // Member detail pages add KvK number, address and website. A failure here keeps the list data.
    const records = [];
    for (const c of matches.slice(0, MAX_DETAILS)) {
      const rec = { name: c.name, kvk: '', address: '', website: '', certificate: c.certificate,
        certificate_status: c.certificate_status, profile_url: BASE + c.href };
      if (timeLeft()) {
        try {
          const d = await get(rec.profile_url);
          if (d.ok) addDetail(d.body, rec);
        } catch (_) { /* keep the list data */ }
      }
      records.push(rec);
    }

    const first1 = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: `${first1.name} | KvK ${first1.kvk || '?'} | ${first1.address || '?'}`.slice(0, 500),
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
