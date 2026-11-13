export const meta = {
  task: 'AU-startlocal.com.au',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'location', 'abn', 'profile_url'],
  canary: { found: 'A & M East Brunswick Auto Care', not_found: 'ZZQX Nonexistent Holdings Pty Ltd' },
};

// StartLocal "Companies A-Z" index: /atoz/<letter>.html?q=<name> filters the listing by name on the server
// and prints "N companies matching “…”". Plain HTML, no login, no token.
const BASE = 'https://www.startlocal.com.au';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // 5 x 100 listings; more than that is couldnt_check, never not_found
const START_NEW_FETCH_MS = 30000; // a new fetch starts only before 30 s, so 30 s + 25 s signal < 60 s

// Trailing legal forms, removed on both sides before comparing (ACME TRADING SDN BHD == ACME Trading).
const LEGAL = /[\s,.]*\b(pty|ltd|limited|pte|sdn|bhd|inc|llc|llp|co|corp|corporation|company|plc|gmbh)\.?\s*$/i;

function stripLegal(s) {
  let out = String(s || '').trim();
  let prev;
  do {
    prev = out;
    out = out.replace(LEGAL, '').trim();
  } while (out !== prev && out !== '');
  return out || String(s || '').trim();
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Comparison key: legal form removed, accents removed, case and punctuation ignored.
function key(s) {
  return stripLegal(decode(s))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]/g, '');
}

function bucketFor(core) {
  const m = core.normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[A-Za-z0-9]/);
  if (!m) return null;
  const c = m[0].toLowerCase();
  return /[a-z]/.test(c) ? `${c}.html` : '0-9.html';
}

function parseEntries(html) {
  const out = [];
  const re = /<a href="([^"]+\.html)"[^>]*>\s*<span class="c">\s*<b>([\s\S]*?)<\/b>\s*<small>([\s\S]*?)<\/small>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = decode(m[2]);
    const small = decode(m[3]);
    const parts = small.split(/\s+·\s+/);
    out.push({
      name,
      category: parts.length > 1 ? parts[0] : '',
      location: parts.length > 1 ? parts.slice(1).join(' · ') : small,
      url: new URL(m[1], BASE).href,
      text: `${name} · ${small}`,
    });
  }
  return out;
}

function fail(reason, excerpt, source_url = '') {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function fetchOpts() {
  return {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-AU,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const input = String(keyword ?? '').trim();
  let sourceUrl = '';
  try {
    const core = stripLegal(input);
    const k = key(input);
    if (!k) return fail('other', 'the name has no Latin letters or digits; the A-Z index is Latin-only');
    const bucket = bucketFor(core);
    if (!bucket) return fail('other', 'no A-Z page for this first character');

    const base = `${BASE}/atoz/${bucket}`;
    const q = `q=${encodeURIComponent(core)}`;
    sourceUrl = `${base}?${q}`;

    const entries = [];
    let countText = '';
    for (let page = 1; ; page++) {
      if (page > 1 && elapsed() > START_NEW_FETCH_MS) return fail('timeout', 'paging the A-Z search ran past the time budget', sourceUrl);
      const url = page === 1 ? `${base}?${q}` : `${base}?${q}&page=${page}`;
      const res = await fetch(url, fetchOpts());
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`, url);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`, url);
      const html = await res.text();

      const m = html.match(/(\d[\d,]*)\s+compan(?:y|ies)\s+matching/i);
      if (!m) {
        if (/captcha|cf-chl|Just a moment|Attention Required/i.test(html)) return fail('blocked', 'bot or captcha page', url);
        return fail('layout_changed', html.slice(0, 300), url);
      }
      countText = m[0];
      const pageTotal = Number(m[1].replace(/,/g, ''));
      const parsed = parseEntries(html);
      const expected = Math.min(100, Math.max(0, pageTotal - (page - 1) * 100));
      if (parsed.length < expected) {
        return fail('layout_changed', `page ${page}: read ${parsed.length} listings, the page says ${expected}`, url);
      }
      entries.push(...parsed);
      if (!/rel="next"/.test(html)) break;
      if (page === MAX_PAGES) return fail('other', `more than ${MAX_PAGES * 100} listings match "${core}"; not all checked`, url);
    }

    const matches = entries.filter((e) => key(e.name) === k);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `${countText}; no listing is named "${input}"`.slice(0, 300),
      };
    }

    const records = [];
    for (const e of matches.slice(0, 5)) {
      const rec = { name: e.name, category: e.category, location: e.location, abn: '', profile_url: e.url };
      if (elapsed() < START_NEW_FETCH_MS) {
        try {
          const pr = await fetch(e.url, fetchOpts());
          if (pr.ok) {
            const ph = await pr.text();
            const am = ph.match(/ABN\s*((?:\d\s*){11})/);
            if (am) rec.abn = am[1].replace(/\D/g, '');
          }
        } catch {
          // ABN is optional: the listing itself proves the company is there, so the record keeps abn ''.
        }
      }
      records.push(rec);
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: matches[0].text.slice(0, 300),
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, String(err?.message || err), sourceUrl);
  }
}
