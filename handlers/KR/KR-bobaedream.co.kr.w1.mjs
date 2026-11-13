export const meta = {
  task: 'KR-bobaedream.co.kr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'partner_no', 'category', 'representative', 'address', 'phone', 'hours', 'homepage'],
  canary: { found: '타스카모터스', not_found: '가나다라마바사' },
};

// Bobaedream is a car forum. Its only company-style directory is the partner list (협력업체찾기): car-service,
// parts and tuning shops that registered on the site. This handler searches that list by business name.

const BASE = 'https://www.bobaedream.co.kr';
const SEARCH_URL = `${BASE}/partner/partner_search.php`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed before comparing names.
const LEGAL = /\(주\)|\(유\)|\(사\)|\(재\)|주식회사|유한회사|\bco\.?\s*,?\s*ltd\.?|\bsdn\.?\s*bhd\.?|\bbhd\.?|\bpte\.?\s*ltd\.?|\binc\.?|\bllc\b|\bcorp\.?|\bcorporation\b|\blimited\b|\bltd\.?|\bco\b|\bcompany\b/gi;

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Normalised name for comparison: NFKC, legal form removed, lower case, letters and digits only. */
function cleanName(s) {
  return String(s || '').normalize('NFKC').replace(LEGAL, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Search text as typed: NFKC, legal form removed, spaces collapsed. */
function searchTerm(s) {
  return String(s || '').normalize('NFKC').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
}

function firstChars(s, n) {
  return Array.from(s).slice(0, n).join('');
}

function text(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// The site reads form posts as EUC-KR, so the search text must be sent as EUC-KR bytes.
// Build the character -> bytes map from the decoder itself (no packages available).
let eucMap = null;
function eucKrMap() {
  if (eucMap) return eucMap;
  const dec = new TextDecoder('euc-kr');
  eucMap = new Map();
  for (let lead = 0xa1; lead <= 0xfe; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const ch = dec.decode(Uint8Array.of(lead, trail));
      if (ch.length === 1 && ch !== '�' && !eucMap.has(ch)) eucMap.set(ch, [lead, trail]);
    }
  }
  return eucMap;
}

/** Percent-encoded EUC-KR for a form field, or null if a character cannot be encoded. */
function toEucKrPercent(str) {
  const map = eucKrMap();
  const parts = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      parts.push('%' + code.toString(16).toUpperCase().padStart(2, '0'));
      continue;
    }
    const pair = map.get(ch);
    if (!pair) return null;
    parts.push('%' + pair[0].toString(16).toUpperCase() + '%' + pair[1].toString(16).toUpperCase());
  }
  return parts.join('');
}

async function get(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(25000),
  });
  const buf = await res.arrayBuffer();
  return { status: res.status, html: new TextDecoder('euc-kr').decode(buf) };
}

/** Rows of the partner result table. Each row's onClick is go_view(<partner no>). */
function parseRows(html) {
  const starts = [];
  const re = /go_view\((\d+)\)/g;
  let m;
  while ((m = re.exec(html))) starts.push({ no: m[1], at: m.index });
  return starts.map((h, i) => {
    const end = Math.min(starts[i + 1] ? starts[i + 1].at : html.length, h.at + 3000);
    const block = html.slice(h.at, end);
    const name = text((block.match(/<strong>([\s\S]*?)<\/strong>/i) || [])[1]);
    const category = text((block.match(/class="text_13"[^>]*>([\s\S]*?)<\/td>/i) || [])[1]);
    const phone = text((block.match(/<strong>전화<\/strong>\s*:([\s\S]*?)<\/td>/i) || [])[1]);
    const address = text((block.match(/<strong>주소<\/strong>\s*:([\s\S]*?)<\/td>/i) || [])[1]);
    return { no: h.no, name, category, phone, address };
  });
}

/** Detail page: representative, opening hours, homepage. Missing fields stay empty. */
async function detailFields(no) {
  const url = `${BASE}/partner/partner_view.php?no=${no}`;
  const out = { url, representative: '', hours: '', homepage: '' };
  try {
    const d = await get(url);
    if (d.status !== 200) return out;
    const s = text(d.html);
    out.representative = (s.match(/대표자\s*:\s*(.+?)\s+주소\s*:/) || [])[1] || '';
    out.hours = (s.match(/업무시간\s*:\s*(.+?)\s+홈페이지\s*:/) || [])[1] || '';
    out.homepage = (s.match(/홈페이지\s*:\s*(\S+)/) || [])[1] || '';
  } catch {
    // Keep the list fields; the detail is optional.
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = cleanName(keyword);
    if (!wanted) return fail('other', SEARCH_URL, 'empty company name');

    const term = searchTerm(keyword);
    // The form allows 10 characters; the full name is still compared after the search.
    // A second try without spaces covers names the site writes without them.
    const variants = [...new Set([firstChars(term, 10), firstChars(term.replace(/\s+/g, ''), 10)])].filter(Boolean);

    let matched = null;
    for (const v of variants) {
      const enc = toEucKrPercent(v);
      if (enc === null) return fail('other', SEARCH_URL, 'name has characters the site cannot take (not EUC-KR)');

      const r = await get(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `search_name=b_name&search_str=${enc}&order=`,
      });
      if (r.status === 403 || r.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${r.status}`);
      if (r.status !== 200) return fail('http_error', SEARCH_URL, `HTTP ${r.status}`);

      if (!r.html.includes('협력업체찾기') || !r.html.includes('partner_search')) {
        if (/captcha|보안문자|접근이\s*차단|bot\s*check/i.test(r.html)) return fail('blocked', SEARCH_URL, 'bot check page');
        return fail('layout_changed', SEARCH_URL, text(r.html).slice(0, 300));
      }

      const hits = parseRows(r.html).filter((row) => cleanName(row.name) === wanted);
      if (hits.length) {
        matched = hits;
        break;
      }
    }

    if (!matched) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `No partner listing named "${keyword}" in the Bobaedream partner directory (협력업체찾기). The directory covers car-service and parts shops only.`,
      };
    }

    const records = [];
    for (const row of matched) {
      const d = await detailFields(row.no);
      records.push({
        name: row.name,
        partner_no: row.no,
        category: row.category,
        representative: d.representative,
        address: row.address,
        phone: row.phone,
        hours: d.hours,
        homepage: d.homepage,
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matched.map((row) => `${BASE}/partner/partner_view.php?no=${row.no}`)[0],
      excerpt: records
        .map((r) => `${r.name} | ${r.category} | ${r.address} | ${r.phone}`)
        .join(' ; ')
        .slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SEARCH_URL, String((err && err.message) || err));
  }
}
