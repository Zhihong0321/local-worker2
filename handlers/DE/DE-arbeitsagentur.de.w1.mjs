export const meta = { task: 'DE-arbeitsagentur.de', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'name1', 'name2', 'name3', 'street', 'house_number', 'postcode', 'city', 'country', 'agency_number'],
  canary: { found: 'Adecco Personaldienstleistungen GmbH', not_found: 'Musterfirma Nichtexistierend GmbH' } };

// The BA permit-holder register (Erlaubnisinhaber). The portal page loads ./json/gesamt.json as a script; the
// file is about 4.7 MB and the server is sometimes slow, so it is read in 12 parallel byte-range requests
// (each well under the 25 s limit). Matching is done here in the handler.
const PORTAL_URL = 'https://www.spitzenverbaende.arbeitsagentur.de/';
const LIST_URL = 'https://www.spitzenverbaende.arbeitsagentur.de/json/gesamt.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHUNK = 400000; // bytes per range request
const CHUNKS = 12;    // 12 x 400000 bytes = 4.8 MB, the list is about 4.7 MB
// Legal-form words ignored when comparing names ("GmbH & Co. KG" loses gmbh, co and kg).
const LEGAL = new Set(['gmbh', 'ag', 'kg', 'kgaa', 'ug', 'ohg', 'gbr', 'mbh', 'co', 'se', 'ltd', 'sia', 'ev', 'ek', 'e', 'k', 'bv', 'sa', 'sl']);

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Comparison key: lower case, umlauts and accents folded, punctuation and legal-form words removed. */
function norm(s) {
  const t = String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t.split(/[^a-z0-9]+/).filter((w) => w && !LEGAL.has(w)).join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = norm(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PORTAL_URL,
        excerpt: 'the name has no letters or digits to compare' };
    }

    const parts = await Promise.all(Array.from({ length: CHUNKS }, (_, i) => {
      const start = i * CHUNK;
      return fetch(LIST_URL, {
        headers: { 'User-Agent': UA, 'Accept': '*/*', 'Range': `bytes=${start}-${start + CHUNK - 1}` },
        signal: AbortSignal.timeout(25000),
      }).then(async (res) => {
        if (res.status === 416) return { past_end: true };           // range starts after the end of the file
        if (res.status === 403 || res.status === 429) return { blocked: res.status };
        if (res.status === 200) return { full: true, bytes: new Uint8Array(await res.arrayBuffer()) }; // Range ignored
        if (res.status !== 206) return { http_error: res.status };
        const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
        return { total: m ? Number(m[1]) : null, bytes: new Uint8Array(await res.arrayBuffer()) };
      });
    }));

    const blocked = parts.find((p) => p.blocked);
    if (blocked) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${blocked.blocked}` };
    }
    const bad = parts.find((p) => p.http_error);
    if (bad) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${bad.http_error}` };
    }

    let bytes;
    const full = parts.find((p) => p.full);
    if (full) {
      bytes = full.bytes;
    } else {
      const total = (parts.find((p) => p.total) || {}).total;
      if (!total) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: 'no Content-Range size' };
      }
      if (total > CHUNKS * CHUNK) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
          excerpt: `list is ${total} bytes, more than the ${CHUNKS * CHUNK} this handler reads` };
      }
      for (let i = 0; i < CHUNKS; i++) {
        const expected = Math.min(CHUNK, total - i * CHUNK);
        if (expected <= 0) continue;
        if (!parts[i].bytes || parts[i].bytes.length !== expected) {
          return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: `chunk ${i} incomplete` };
        }
      }
      bytes = new Uint8Array(total);
      for (let i = 0; i < CHUNKS; i++) {
        if (parts[i].bytes) bytes.set(parts[i].bytes, i * CHUNK);
      }
    }

    // Decode after joining the bytes, so multi-byte UTF-8 characters split at a chunk edge are not broken.
    const text = new TextDecoder('utf-8').decode(bytes);
    const wrapped = text.match(/^\s*processVerleiher\(([\s\S]*)\)\s*;?\s*$/);
    if (!wrapped) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: text.slice(0, 200) };
    }
    let list;
    try {
      list = JSON.parse(wrapped[1]);
    } catch (e) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: 'list is not valid JSON' };
    }
    if (!Array.isArray(list) || list.length < 1000) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: `list has ${Array.isArray(list) ? list.length : 'no'} entries` };
    }

    const matches = list.filter((e) => norm([e.name1, e.name2, e.name3].filter(Boolean).join(' ')) === want);
    const records = matches.map((e) => ({
      name: [e.name1, e.name2, e.name3].map(clean).filter(Boolean).join(' '),
      name1: clean(e.name1),
      name2: clean(e.name2),
      name3: clean(e.name3),
      street: clean(e.strasse),
      house_number: clean(e.hausnr),
      postcode: clean(e.plz),
      city: clean(e.ort),
      country: clean(e.staat),
      agency_number: clean(e.hauptagenturnummer),
    }));

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PORTAL_URL,
        excerpt: `0 of ${list.length} register entries match "${clean(keyword)}"` };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PORTAL_URL,
      excerpt: records.slice(0, 3).map((r) => `${r.name}, ${r.street} ${r.house_number}, ${r.postcode} ${r.city}, ${r.country}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
