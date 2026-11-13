export const meta = {
  task: 'CH-hotelleriesuisse.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'town', 'stars', 'classification', 'address', 'phone', 'website', 'detail_url', 'detail_status'],
  canary: { found: 'Hotel Belvedere Locarno', not_found: 'Hotel Nebelschwaden Zauberberg AG' },
};

const BASE = 'https://www.hotelleriesuisse.ch';
const DIR = '/de/verband/mitgliedschaft/mitgliederverzeichnis';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = () => AbortSignal.timeout(25000);
// Optional extra fetches (more result pages, detail pages) only start before this many ms, so the call stays under 60 s.
const OPTIONAL_UNTIL_MS = 20000;
// Legal-form words, dropped from the END of the typed name before searching and comparing.
const LEGAL_FORMS = new Set(['ag', 'sa', 'sagl', 'sarl', 'gmbh', 'ltd', 'llc', 'inc', 'kg', 'ohg', 'ug', 'se', 'srl', 'spa', 'sl', 'bv', 'nv', 'ab', 's', 'a']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Folds a name for comparison: case, accents, punctuation and "&" vs "and" do not matter.
function fold(s) {
  return decodeEntities(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isLegalWord(w) {
  return LEGAL_FORMS.has(fold(w).replace(/\s+/g, ''));
}

// Splits the typed name into the core name (legal form removed from the end) and compares normalised core names.
function coreName(keyword) {
  const words = (keyword || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && isLegalWord(words[words.length - 1].replace(/\./g, ''))) words.pop();
  return words.join(' ');
}

function normaliseForMatch(name) {
  const words = fold(name).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function blockedOr(res, url) {
  if (res.status === 403 || res.status === 429) {
    return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
  }
  return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
}

function botWall(html) {
  return /captcha|cf-chl|Just a moment|Access denied/i.test(html.slice(0, 20000));
}

function parseCards(html) {
  const cards = [];
  const chunks = html.split('<li class="CardGrid--grid-item">').slice(1);
  for (const chunk of chunks) {
    const href = chunk.match(/<a class="Card small" href="([^"]+)"/);
    const title = chunk.match(/<strong class="Card--title">([\s\S]*?)<\/strong>/);
    if (!href || !title) continue;
    const subtitle = chunk.match(/<em class="Card--subtitle">([\s\S]*?)<\/em>/);
    const stars = title[1].match(/stars-(\d)/);
    const classification = title[1].match(/title="([^"]*Hotel[^"]*)"/);
    cards.push({
      name: cleanText(title[1]),
      town: subtitle ? cleanText(subtitle[1]) : '',
      stars: stars ? Number(stars[1]) : null,
      classification: classification ? decodeEntities(classification[1]) : '',
      detail_url: new URL(decodeEntities(href[1]), BASE).href,
    });
  }
  return cards;
}

function parseCount(html) {
  const m = html.match(/<strong>\s*(\d+)\s*<\/strong>\s*von\s*<strong>\s*(\d+)\s*<\/strong>/);
  return m ? { matched: Number(m[1]), total: Number(m[2]) } : null;
}

function parsePageLinks(html, currentUrl) {
  const out = new Set();
  const re = /href="([^"]*mitgliederverzeichnis\/hotel-page-\d+\?[^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const url = new URL(decodeEntities(m[1]), BASE).href;
    if (url !== currentUrl) out.add(url);
  }
  return [...out];
}

// Reads the detail page of one member: address, phone, website, classification.
async function readDetail(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: TIMEOUT() });
  if (!res.ok) return { detail_status: `HTTP ${res.status}` };
  const html = await res.text();
  const address = html.match(/data-picto="marker"><svg[\s\S]*?<\/svg><\/span>([\s\S]*?)<\/a>/i);
  const phone = html.match(/href="tel:[^"]*"[\s\S]*?<\/svg><\/span>([\s\S]*?)<\/a>/i);
  const web = html.match(/<a href="(https?:\/\/[^"]+)"[^>]*class="HeaderInfobar--link"/i);
  const klass = html.match(/Klassiert als ([^<]+?) durch/i);
  return {
    address: address ? cleanText(address[1]) : '',
    phone: phone ? cleanText(phone[1]) : '',
    website: web ? decodeEntities(web[1]) : '',
    classification: klass ? cleanText(klass[1]) : '',
    detail_status: 'ok',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const dirUrl = BASE + DIR;
  try {
    const core = coreName(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: dirUrl, excerpt: 'empty name' };
    }

    // Step 1: the member directory page carries the search form with its security tokens (cHash, trusted fields).
    const pageRes = await fetch(dirUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: TIMEOUT() });
    if (!pageRes.ok) return blockedOr(pageRes, dirUrl);
    const pageHtml = await pageRes.text();
    if (botWall(pageHtml)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: dirUrl, excerpt: 'bot check page' };
    }
    const form = [...pageHtml.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
      .find((f) => /method="post"/i.test(f[1]) && /rtpconfighosu/i.test(f[1]));
    if (!form) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: dirUrl, excerpt: 'member search form not found' };
    }
    const actionAttr = form[1].match(/action="([^"]+)"/i);
    const actionUrl = new URL(decodeEntities(actionAttr[1]), BASE).href;

    const body = new URLSearchParams();
    for (const input of form[2].match(/<input\b[^>]*>/gi) || []) {
      if (!/type="hidden"/i.test(input)) continue;
      const name = input.match(/name="([^"]*)"/i);
      const value = input.match(/value="([^"]*)"/i);
      if (name) body.append(decodeEntities(name[1]), decodeEntities(value ? value[1] : ''));
    }
    body.set('tx_rtpconfighosu_hotel[filter][member]', core);

    // Step 2: the search is a POST; the site answers 303 to a filtered results page, which fetch follows.
    const searchRes = await fetch(actionUrl, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', Referer: dirUrl },
      body: body.toString(),
      signal: TIMEOUT(),
    });
    const searchUrl = searchRes.url || actionUrl;
    if (!searchRes.ok) return blockedOr(searchRes, searchUrl);
    const html = await searchRes.text();
    if (botWall(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
    }

    const count = parseCount(html);
    if (!count) {
      // A search with no hits renders the directory with no count line and no cards, and the typed term is echoed
      // back in the member search box. That is a normal empty answer; anything else is a layout we do not know.
      const box = html.match(/<input[^>]*tx_rtpconfighosu_hotel\[filter\]\[member\][^>]*>/i);
      const echo = box && box[0].match(/value="([^"]*)"/i);
      const echoed = echo ? decodeEntities(echo[1]) : null;
      const noCards = parseCards(html).length === 0;
      if (noCards && echoed !== null && fold(echoed) === fold(core) && /Unsere Mitglieder|Mitglieder durchsuchen/.test(html)) {
        return {
          status: 'not_found', reason: '', records: [], source_url: searchUrl,
          excerpt: `0 members match "${core}" (the member directory answered with an empty list)`,
        };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: html.slice(0, 200) };
    }
    if (count.matched === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 of ${count.total} members match "${core}"`,
      };
    }

    // Step 3: read the result cards; a long result list has more pages, read while there is time.
    const target = normaliseForMatch(core);
    let cards = parseCards(html);
    const seenPages = new Set([searchUrl]);
    let pendingPages = parsePageLinks(html, searchUrl);
    let pagesUnread = 0;
    while (pendingPages.length) {
      const next = pendingPages.shift();
      if (seenPages.has(next)) continue;
      seenPages.add(next);
      if (Date.now() - started > OPTIONAL_UNTIL_MS) { pagesUnread++; continue; }
      const pr = await fetch(next, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: TIMEOUT() });
      if (!pr.ok) { pagesUnread++; continue; }
      const ph = await pr.text();
      cards = cards.concat(parseCards(ph));
    }

    const hits = [];
    const seenUrls = new Set();
    for (const card of cards) {
      if (normaliseForMatch(card.name) !== target) continue;
      if (seenUrls.has(card.detail_url)) continue;
      seenUrls.add(card.detail_url);
      hits.push(card);
    }

    if (hits.length === 0) {
      const extra = pagesUnread ? `; ${pagesUnread} result page(s) not read in time` : '';
      if (pagesUnread) {
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `results for "${core}" were not all read${extra}`,
        };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${count.matched} member(s) match "${core}" but none has the same name`,
      };
    }

    // Step 4: detail pages for the matches (address, phone, website), while there is time.
    const records = [];
    for (const hit of hits.slice(0, 3)) {
      const rec = { name: hit.name, town: hit.town, stars: hit.stars, classification: hit.classification, address: '', phone: '', website: '', detail_url: hit.detail_url, detail_status: 'skipped' };
      if (Date.now() - started <= OPTIONAL_UNTIL_MS) {
        try {
          Object.assign(rec, await readDetail(hit.detail_url));
        } catch (e) {
          rec.detail_status = 'error: ' + String(e?.name || e).slice(0, 60);
        }
      }
      records.push(rec);
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${first.name}, ${first.town}${first.stars ? `, ${first.stars}-star hotel` : ''}${first.address ? `, ${first.address}` : ''}`.slice(0, 500),
    };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: dirUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
