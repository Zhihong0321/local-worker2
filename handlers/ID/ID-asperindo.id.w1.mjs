export const meta = { task: 'ID-asperindo.id', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'trade_name'], canary: { found: 'PT. Acc Express', not_found: 'PT. Sumber Rezeki Bahagia Lestari' } };

const SOURCE_URL = 'https://www.asperindo.id/keorganisasian/anggota/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_NAMES = 50; // the roster page lists about 170 names; fewer than this means the page is cut short or changed

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'" };

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Legal forms are dropped before comparing, so "PT. Acc Express", "PT ACC EXPRESS" and "Acc Express" compare equal.
function core(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\((persero)\)/g, ' ')
    .replace(/\b(pt|cv|tbk|persero|ud|perum|koperasi|yayasan)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

// A roster entry is "Legal name (trade name)"; both parts count as the company's own name.
function keysOf(name) {
  const trade = tradeNameOf(name);
  const legal = trade ? name.replace(/\(([^()]*)\)\s*$/, '') : name;
  return { legal: core(legal), trade: core(trade) };
}

// The brand in parentheses, e.g. "GoSend" in "PT. Paket Anak Bangsa (GoSend)". A legal form like "(Persero)" is not a brand.
function tradeNameOf(name) {
  const m = name.match(/\(([^()]*)\)\s*$/);
  if (!m) return '';
  const t = m[1].trim();
  return core(t) === '' || /^persero$/i.test(t) ? '' : t;
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = keysOf(String(keyword || '').trim());
    if (!kw.legal && !kw.trade) return fail('couldnt_check', 'other', SOURCE_URL, 'empty company name');

    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', SOURCE_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', SOURCE_URL, `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|cf-chl|checking your browser/i.test(html)) return fail('couldnt_check', 'blocked', SOURCE_URL, 'bot check page');

    const start = html.search(/Daftar anggota ASPERINDO/i);
    if (start < 0) return fail('couldnt_check', 'layout_changed', SOURCE_URL, html.slice(0, 300));
    const endMarker = html.indexOf('id="footer_contents"', start);
    const section = html.slice(start, endMarker > start ? endMarker : undefined);

    const names = [];
    for (const m of section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      const text = cleanText(m[1]);
      if (/^(PT|CV|UD|Perum|Koperasi|Yayasan)\b/i.test(text)) names.push(text);
    }
    if (names.length < MIN_NAMES) {
      return fail('couldnt_check', 'layout_changed', SOURCE_URL, `only ${names.length} member names found`);
    }

    // Match when the legal names are equal, or when the keyword is the trade name of the entry.
    // Two different companies never share a legal name, so this is not a loose similarity match.
    const matches = names.filter((name) => {
      const k = keysOf(name);
      return (kw.legal && k.legal === kw.legal) || (kw.legal && k.trade === kw.legal);
    });

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SOURCE_URL,
        excerpt: `No match among ${names.length} member names on the ASPERINDO member list`,
      };
    }

    return {
      status: 'found', reason: '',
      records: matches.map((name) => ({ name, trade_name: tradeNameOf(name) })),
      source_url: SOURCE_URL,
      excerpt: matches.join(' | ').slice(0, 300),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timedOut ? 'timeout' : 'other', SOURCE_URL, String(err && err.message || err));
  }
}
