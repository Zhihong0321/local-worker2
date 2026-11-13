export const meta = { task: 'CH-swissbanking.ch', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'location', 'website'],
  canary: { found: 'Zürcher Kantonalbank', not_found: 'Bergbauern-Bank Zweisimmen AG' } };

// The Swiss Bankers Association publishes its full list of member institutions on one static HTML page
// (about 258 entries, one <h4> per entry: "<a href=website>Name</a> | POSTCODE City").
const LIST_URL = 'https://www.swissbanking.ch/en/about-us/membership/member-institutions';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

// Legal-form words dropped from the END of a name, so "Zuger Kantonalbank" and "Zuger Kantonalbank AG" compare equal.
const LEGAL_FORMS = new Set(['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'ltd', 'kg', 'se', 'llc', 'inc', 'genossenschaft', 'cooperative']);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** All member entries on the page: { name, location, website }. */
function parseEntries(html) {
  const out = [];
  for (const m of html.matchAll(/<h4>([\s\S]*?)<\/h4>/g)) {
    const inner = m[1];
    const parts = cleanText(inner).split(/\s\|\s/);
    if (parts.length !== 2 || !/^\d{4}\s/.test(parts[1].trim())) continue;
    const link = inner.match(/<a[^>]*href="(https?:\/\/[^"]+)"/i);
    out.push({ name: parts[0].trim(), location: parts[1].trim(), website: link ? link[1] : '' });
  }
  return out;
}

/** Comparison key: case, accents, punctuation and trailing legal form ignored. mode 'ue' writes ü as "ue" (ZUERCHER). */
function keyOf(raw, mode) {
  let s = String(raw).normalize('NFC').toLowerCase().replace(/&|\+/g, ' and ');
  s = mode === 'ue'
    ? s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    : s.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u');
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9 ]+/g, ' ').trim();
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

function keysOf(raw) {
  return new Set([keyOf(raw, 'plain'), keyOf(raw, 'ue')]);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword ?? '').trim();
  try {
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': ACCEPT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    // On this Windows Node build, exiting right after a keep-alive fetch can abort with a libuv assertion (exit 127)
    // while the socket is still closing. A short pause after the body is read avoids it; the answer is unaffected.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const entries = parseEntries(html);
    if (entries.length === 0) {
      if (/captcha|cloudflare|access denied|verify you are human/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: cleanText(html).slice(0, 300) };
    }

    const wanted = keysOf(kw);
    const matches = entries.filter((e) => [...keysOf(e.name)].some((k) => wanted.has(k)));

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No match for "${kw}" among ${entries.length} member institutions listed on the page`,
      };
    }

    return {
      status: 'found', reason: '',
      records: matches.map((e) => ({ name: e.name, location: e.location, website: e.website })),
      source_url: LIST_URL,
      excerpt: `Listed as: ${matches[0].name} | ${matches[0].location}`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
