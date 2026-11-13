export const meta = { task: 'IN-tofler.in', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'cin', 'status', 'registered_address', 'incorporation_date', 'paidup_capital', 'company_url'],
  canary: { found: 'TATA STEEL LIMITED', not_found: 'Zxqvbnm Qwerty Nonexistent Ltd' } };

const SITE = 'https://www.tofler.in';
const SEARCH_URL = SITE + '/cnamesearch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'plc', 'opc', 'llc']);
const SUGGESTION_CAP = 10; // the site's autocomplete never returns more than 10 suggestions

/** MD5 of the UTF-8 bytes of a string, as lowercase hex. Same digest the site's own autocomplete computes. */
function md5Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const bitLen = len * 8;
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 4294967296) >>> 0;
  for (let i = 0; i < 4; i++) {
    msg[total - 8 + i] = (lo >>> (8 * i)) & 0xff;
    msg[total - 4 + i] = (hi >>> (8 * i)) & 0xff;
  }
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    const M = [];
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      M[j] = (msg[p] | (msg[p + 1] << 8) | (msg[p + 2] << 16) | (msg[p + 3] << 24)) >>> 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  let hex = '';
  for (const w of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) hex += ((w >>> (8 * i)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Normalised name: lower case, punctuation removed, legal-form words removed. */
function core(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
}

/** Site labels look like "TATA MOTORS PASSENGER VEHICLES LIMITED (Tata Motors)": the bracket is an alias. */
function officialName(label) {
  return String(label).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function timeoutOr(e, fallback) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : fallback;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const kcore = core(name);
  const fail = (reason, excerpt, source = SEARCH_URL) =>
    ({ status: 'couldnt_check', reason, records: [], source_url: source, excerpt: String(excerpt).slice(0, 300) });
  try {
    // Step 1: the site's own autocomplete request (POST form, nonce = md5("a" + term)).
    const body = new URLSearchParams({ cname: name, nonce: md5Hex('a' + name) });
    let res;
    try {
      res = await fetch(SEARCH_URL, {
        method: 'POST',
        body,
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': SITE,
          'Referer': SITE + '/',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      return fail(timeoutOr(e, 'other'), e && e.message || e);
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return fail('blocked', `HTTP ${res.status}`);
    }
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    if (/Internal Server Error/i.test(text) && !text.trim().startsWith('[')) {
      return fail('http_error', 'HTTP 200 but the site returned its "500 Internal Server Error" page for this name');
    }
    let items;
    try { items = JSON.parse(text); } catch { return fail('layout_changed', text.slice(0, 200)); }
    if (!Array.isArray(items)) return fail('layout_changed', text.slice(0, 200));

    const entries = items.filter((it) => it && it.subtype !== 'nomatch' && typeof it.label === 'string' && it.label);

    // Step 2: match on the normalised name. Same name with a different legal form is still the same company.
    const matches = entries.filter((it) => {
      if (!kcore) return false;
      return core(officialName(it.label)) === kcore || core(it.label) === kcore;
    });

    if (matches.length === 0) {
      if (entries.length >= SUGGESTION_CAP) {
        return fail('other', `the site shows only its first ${SUGGESTION_CAP} suggestions and none has this exact name`);
      }
      const shown = entries.map((it) => it.label).slice(0, 3).join(' ; ');
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: entries.length ? `No company with this name. Site suggested: ${shown}` : 'Tofler search: "No companies found"',
      };
    }

    // Step 3: company page (public, server-rendered) for the address, incorporation date and paid-up capital.
    const records = await Promise.all(matches.slice(0, 3).map(async (it) => {
      const rec = {
        name: officialName(it.label),
        cin: String(it.value || ''),
        status: String(it.status || ''),
        registered_address: '',
        incorporation_date: '',
        paidup_capital: '',
        company_url: new URL(String(it.url || ''), SITE).href,
      };
      try {
        const page = await fetch(rec.company_url, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Referer': SITE + '/' },
          signal: AbortSignal.timeout(25000),
        });
        if (page.ok) {
          const html = await page.text();
          const pick = (re) => { const m = html.match(re); return m ? cleanText(m[1]).replace(/\.$/, '').trim() : ''; };
          rec.registered_address = pick(/The registered address of [^<"]{1,200}? is ([^<"]{3,300})/i);
          rec.incorporation_date = pick(/The incorporation date of [^<"]{1,200}? is ([^<"]{3,60})/i);
          rec.paidup_capital = pick(/The paid-up capital of [^<"]{1,200}? is ([^<"]{3,80})/i);
        }
      } catch {
        // The search already proved the company is listed; the detail fields stay empty.
      }
      return rec;
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].company_url,
      excerpt: records.map((r) => [r.name, r.cin, r.status, r.registered_address].filter(Boolean).join(' | ')).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    return fail(timeoutOr(err, 'other'), err && err.message || err);
  }
}
