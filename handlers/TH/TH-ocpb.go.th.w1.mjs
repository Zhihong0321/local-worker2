export const meta = {
  task: 'TH-ocpb.go.th',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_en', 'juristic_id', 'juristic_type', 'juristic_status', 'registration_no', 'register_type',
    'people_type', 'status', 'status_date', 'registered_date', 'request_date', 'address', 'province'],
  canary: { found: 'นู สกิน เอ็นเตอร์ไพร์ส (ประเทศไทย) จำกัด', not_found: 'บริษัท ไม่มีอยู่จริง ทดสอบ 999 จำกัด' },
};

// OCPB Direct (the direct-sales / direct-marketing registry linked from www.ocpb.go.th) is a Vue front end
// that calls this JSON search API: GET {API}?key=<text>&page=<n>, 20 results per page.
const API = 'https://wsocpbdirect.ocpb.go.th/ws/get/search';
const PAGE = 'https://ocpbdirect.ocpb.go.th/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://ocpbdirect.ocpb.go.th',
  'Referer': 'https://ocpbdirect.ocpb.go.th/search',
};
const MAX_PAGES = 5;          // at most 100 results read
const NO_NEW_PAGE_AFTER_MS = 20000; // keeps the whole call under 60 s (each fetch can take up to 25 s)

// Legal-form words, removed before comparing names (Thai and English forms).
const LEGAL_RE = [
  /\(\s*มหาชน\s*\)/giu, /ห้างหุ้นส่วนจำกัด/giu, /ห้างหุ้นส่วนสามัญ/giu, /บริษัท/giu, /จำกัด/giu, /มหาชน/giu,
  /\bpublic\s+company(\s+limited)?\b/giu, /\bcompany\s+limited\b/giu, /\bco\.?\s*,?\s*ltd\.?/giu, /\blimited\b/giu,
  /\bltd\.?/giu, /\bsdn\.?\s*bhd\.?/giu, /\bbhd\.?/giu, /\bpcl\b\.?/giu, /\bplc\b\.?/giu, /\binc\.?/giu,
  /\bcorp(oration)?\.?/giu, /\bllc\b\.?/giu, /\bco\b\.?/giu,
];

// NFKC splits Thai "ำ" into two code points, so the Thai patterns are normalised the same way.
const LEGAL_NFKC = LEGAL_RE.map((re) => new RegExp(re.source.normalize('NFKC'), re.flags));

function stripLegal(s) {
  let t = String(s || '').normalize('NFKC');
  for (const re of LEGAL_NFKC) t = t.replace(re, ' ');
  return t.replace(/[,.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Comparison key: lower case, legal form removed, only letters, marks and digits kept. */
function core(s) {
  return stripLegal(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

function out(status, reason, source_url, records, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Fetch one results page. Returns { data } or { fail } (a finished couldnt_check answer). */
async function getPage(key, page) {
  const url = `${API}?key=${encodeURIComponent(key)}&page=${page}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const body = await res.text();
  if (res.status === 403 || res.status === 429) {
    return { fail: out('couldnt_check', 'blocked', url, [], `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { fail: out('couldnt_check', 'http_error', url, [], `HTTP ${res.status}`) };
  }
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  if (!json) {
    if (/incapsula|_Incapsula_Resource|captcha|access denied/i.test(body.slice(0, 5000))) {
      return { fail: out('couldnt_check', 'blocked', url, [], 'bot check page returned instead of JSON') };
    }
    return { fail: out('couldnt_check', 'layout_changed', url, [], body.slice(0, 300)) };
  }
  if (json.success !== true || !json.data || !Array.isArray(json.data.list)) {
    return { fail: out('couldnt_check', 'layout_changed', url, [], JSON.stringify(json).slice(0, 300)) };
  }
  return { data: json.data, url };
}

function toRecord(x) {
  const j = x.juristic_info || {};
  const a = x.juristic_address_info || {};
  const address = ['address_no', 'building', 'room_no', 'floor', 'village_name', 'moo', 'soi', 'road', 'tumbol', 'ampur', 'province', 'zip_code']
    .map((k) => a[k])
    .filter((v) => v != null && String(v).trim() !== '')
    .map(String)
    .join(' ');
  return {
    name: j.name || '',
    name_en: j.name_en || '',
    juristic_id: j.juristic_id || '',
    juristic_type: j.juristic_type || '',
    juristic_status: j.juristic_status || '',
    registration_no: x.ocpb_id || '',
    register_type: x.register_type?.name || '',
    people_type: x.people_type?.name || '',
    status: x.status_register?.name || '',
    status_date: x.status_register?.date || '',
    registered_date: x.registered_date || '',
    request_date: x.request_date || '',
    address,
    province: a.province || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let sourceUrl = '';
  try {
    const raw = String(keyword ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const target = core(raw);
    if (!target) {
      return out('couldnt_check', 'other', '', [], 'the name has no letters or digits left after removing the legal form');
    }
    const key = stripLegal(raw) || raw;

    const seen = [];
    let total = 0;
    let truncated = false;
    for (let page = 1; ; page++) {
      if (page > 1 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) { truncated = true; break; }
      if (page > MAX_PAGES) { truncated = true; break; }
      const r = await getPage(key, page);
      if (r.fail) return r.fail;
      if (page === 1) sourceUrl = r.url;
      const list = r.data.list;
      total = Number(r.data.total) || 0;
      if (list.length === 0 && total > seen.length) {
        return out('couldnt_check', 'layout_changed', r.url, [], `total ${total} but no rows on page ${page}`);
      }
      seen.push(...list);
      if (list.length === 0 || seen.length >= total) break;
    }

    if (seen.length === 0) {
      return out('not_found', '', sourceUrl, [], `OCPB Direct: 0 results for "${key}"`);
    }

    const matches = seen.filter((x) => {
      const j = x.juristic_info;
      return j && [j.name, j.name_en].some((n) => n && core(n) === target);
    });

    const note = truncated ? ` Only ${seen.length} of ${total} results were read; the list may be incomplete.` : '';

    if (matches.length === 0) {
      const names = [...new Set(seen.map((x) => x.juristic_info?.name_en || x.juristic_info?.name || '').filter(Boolean))];
      return out('couldnt_check', 'other', sourceUrl, [],
        `${seen.length} result(s) for "${key}" but none has the same full name. Similar: ${names.slice(0, 5).join('; ')}.${note}`);
    }

    const records = matches.map(toRecord);
    const first = records[0];
    return out('found', '', sourceUrl, records,
      `OCPB Direct: ${records.length} registration(s) for ${first.name} (${first.name_en}), juristic ID ${first.juristic_id}.${note}`);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return out('couldnt_check', timedOut ? 'timeout' : 'other', sourceUrl || API, [],
      String(err?.message || err));
  }
}
