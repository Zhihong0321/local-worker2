export const meta = { task: 'IE-workplacerelations.ie', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'case_ref', 'date', 'parties', 'url'],
  canary: { found: 'Ryanair DAC', not_found: 'Gaelbhun Chluain Ailtire Teoranta' } };

// Decisions and Determinations search (WRC + Labour Court, no body filter). Plain GET, no token, no form POST.
// The search matches any word (OR), so the handler searches the core name only (legal form removed)
// and then checks every party name on the result pages before calling anything found.
const BASE = 'https://www.workplacerelations.ie/en/search/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 10;
const MAX_PAGES = 8;        // 80 results at most
const DEADLINE_MS = 30000;  // no new page after 30 s; each fetch has its own 25 s timeout, so the call ends well under 60 s

// Legal-form words removed before comparing names (both sides).
const LEGAL = new Set(['dac', 'designated', 'activity', 'company', 'ltd', 'limited', 'teo', 'teoranta', 'plc',
  'unlimited', 'uc', 'clg', 'icav', 'llp', 'cuideachta', 'chuideachta', 'rathaiocht']);

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
}

function clean(s) {
  return decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Core name: lower case, no accents or punctuation, legal form removed. */
function coreOf(s) {
  const t = decode(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
    .filter((w) => !LEGAL.has(w));
  if (t[0] === 'the' && t.length > 1) t.shift();
  return t.join(' ');
}

function searchUrl(key, page) {
  const u = new URL(BASE);
  u.searchParams.set('Search.NamesOfParties', key);
  if (page > 1) u.searchParams.set('pageNumber', String(page));
  return u.href;
}

function parseItems(html) {
  const items = [];
  const re = /<li class="each-item[^"]*">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const b = m[1];
    const descAttr = b.match(/class="description"\s+title="([^"]*)"/i);
    const descText = b.match(/<p class="description"[^>]*>([\s\S]*?)<\/p>/i);
    const ref = b.match(/class="refNO">([^<]*)</i);
    const date = b.match(/<span class="date">([^<]*)</i);
    const href = b.match(/<a href="([^"]*)"/i);
    items.push({
      description: clean(descAttr ? descAttr[1] : descText ? descText[1] : ''),
      case_ref: ref ? clean(ref[1]) : '',
      date: date ? clean(date[1]) : '',
      url: href ? new URL(decode(href[1]), 'https://www.workplacerelations.ie').href : '',
    });
  }
  return items;
}

/** Returns the party name (as written) that is the company, or null. Parties are "Name v Company". */
function matchedParty(description, key) {
  const text = description.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  for (const side of text.split(/\s+-?vs?\.?-?\s+/i)) {
    for (const cand of [side, ...side.split(/\s+(?:t\/a|trading as)\s+/i)]) {
      const c = coreOf(cand);
      // exact core name, or a joint party "KEY AND <other>" (Labour Court style)
      if (c && (c === key || c.startsWith(key + ' and '))) return cand.trim();
    }
  }
  return null;
}

const couldnt = (reason, excerpt, source) =>
  ({ status: 'couldnt_check', reason, records: [], source_url: source, excerpt: String(excerpt).slice(0, 300) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startedAt = Date.now();
  const key = coreOf(String(keyword || ''));
  if (!key) return couldnt('other', 'no name left after removing the legal form', BASE);

  let sourceUrl = searchUrl(key, 1);
  const records = [];
  let total = null;
  let pages = 1;
  let page = 1;
  try {
    while (page <= pages) {
      if (page > MAX_PAGES || Date.now() - startedAt > DEADLINE_MS) break; // partial read, handled below
      const url = searchUrl(key, page);
      if (page === 1) sourceUrl = url;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, url);
      if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, url);
      const html = await res.text();
      if (!html.includes('id="searchResult"') || !html.includes('Search.NamesOfParties')) {
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        if (/just a moment|attention required|access denied|captcha/i.test(title)) {
          return couldnt('blocked', `bot check page: ${clean(title)}`, url);
        }
        return couldnt('layout_changed', clean(html).slice(0, 200), url);
      }

      const count = html.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+results/i);
      const items = parseItems(html);
      if (page === 1) {
        if (!count && items.length) return couldnt('layout_changed', 'results without a count line', url);
        total = count ? Number(count[1]) : 0;
        pages = Math.ceil(total / PER_PAGE);
      }
      for (const it of items) {
        const party = matchedParty(it.description, key);
        if (party) records.push({ name: party, case_ref: it.case_ref, date: it.date, parties: it.description, url: it.url });
      }
      page++;
    }
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err), sourceUrl);
  }

  if (records.length) {
    const partial = page <= pages ? ` (read ${page - 1} of ${pages} result pages)` : '';
    return {
      status: 'found', reason: '', records, source_url: sourceUrl,
      excerpt: `${records.length} matching case(s) in ${total} results${partial}: ${records[0].parties}`.slice(0, 300),
    };
  }
  if (total === 0) {
    return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
      excerpt: `The decisions search for "${key}" returned no results` };
  }
  if (page <= pages) {
    const timedOut = Date.now() - startedAt > DEADLINE_MS;
    return couldnt(timedOut ? 'timeout' : 'other',
      `read ${page - 1} of ${pages} result pages for "${key}" (${total} results); the rest were not read`, sourceUrl);
  }
  return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
    excerpt: `${total} results for "${key}" were all read; none names this company as a party` };
}
