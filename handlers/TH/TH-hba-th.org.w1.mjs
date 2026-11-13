export const meta = {
  task: 'TH-hba-th.org',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'tier', 'address', 'phone', 'website'],
  canary: { found: 'บริษัท ริชชี่ เฮ้าส์ จำกัด', not_found: 'บริษัท ตัวอย่างไม่มีอยู่จริง จำกัด' },
};

// The contractor (home builder) member list of the Home Builder Association. The page is server-rendered by Next.js:
// the member rows are JSON objects inside the page's self.__next_f.push([1, "..."]) script chunks, so one GET of the
// list page holds the whole directory. No login, no captcha, no search request is needed.
const LIST_URL = 'https://www.hba-th.org/members/contractor';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words removed before comparing (Thai and English). Longer forms first.
const LEGAL_FORMS = [
  'publiccompanylimited', 'companylimited', 'sdnbhd', 'ห้างหุ้นส่วนจำกัด', 'จำกัดมหาชน', 'มหาชน',
  'บริษัท', 'บจก', 'บมจ', 'หจก', 'จำกัด', 'coltd', 'ltd', 'plc',
];

/** Lower case, NFC, only letters and digits (Thai and Latin); spaces, punctuation and zero-width marks dropped. */
function squash(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/[​-‍﻿]/g, '')
    .replace(/[^a-z0-9฀-๿]+/g, '');
}

/** The company name without its legal form, normalised. */
function core(s) {
  let t = squash(s);
  for (const f of LEGAL_FORMS) t = t.split(f).join('');
  return t;
}

/** The legal name written at the start of an address field, e.g. "บริษัท ณวินดา โฮมบิลด์เดอร์ จำกัด เลขที่ 65/5 ...". */
function legalNameFromAddress(address) {
  const m = String(address || '').trim().match(/^(บริษัท|บจก\.?|บมจ\.?|หจก\.?|ห้างหุ้นส่วนจำกัด)[^]*?(จำกัด\s*\(มหาชน\)|จำกัด)/);
  return m ? m[0] : '';
}

/** Decode the Next.js RSC chunks of the page into one text (JSON-string literals inside the script tags). */
function decodePayload(html) {
  const start = 'self.__next_f.push([1,"';
  const parts = [];
  let i = 0;
  while ((i = html.indexOf(start, i)) !== -1) {
    let j = i + start.length;
    let s = '';
    while (j < html.length && html[j] !== '"') {
      if (html[j] === '\\') { s += html[j] + (html[j + 1] || ''); j += 2; } else { s += html[j]; j++; }
    }
    try { parts.push(JSON.parse('"' + s + '"')); } catch { /* skip a chunk that does not decode */ }
    i = j + 1;
  }
  return parts.join('\n');
}

/** Every contractor member object in the decoded payload, once each. */
function members(payload) {
  const out = [];
  const seen = new Set();
  const re = /\{"id":"[^"]+","name":"[^"]*","category":"contractor"[^{}]*\}/g;
  let m;
  while ((m = re.exec(payload)) !== null) {
    let o;
    try { o = JSON.parse(m[0]); } catch { continue; }
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
  }
  return out;
}

/** The lookup itself. */
async function run(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty keyword' };
    }

    let res;
    try {
      res = await fetch(LIST_URL, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'th,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: LIST_URL,
        excerpt: String(e).slice(0, 200) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!html.includes('self.__next_f.push')) {
      const blocked = /captcha|cf-chl|just a moment|login/i.test(html.slice(0, 20000));
      return { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: html.slice(0, 200) };
    }

    const all = members(decodePayload(html));
    if (all.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: 'no contractor member rows found in the page' };
    }

    const k = core(kw);
    if (!k) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
        excerpt: 'the keyword holds no company name besides the legal form' };
    }

    // Exact match on the normalised name, or on the legal name written in the address. No substring matching.
    const hits = all.filter((o) => {
      if (o.active === false) return false;
      const legal = legalNameFromAddress(o.address);
      return core(o.name) === k || (legal !== '' && core(legal) === k);
    });

    if (hits.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `no exact name match among ${all.length} contractor members` };
    }

    const records = hits.map((o) => ({
      name: o.name,
      legal_name: legalNameFromAddress(o.address),
      tier: o.tier,
      address: o.address,
      phone: o.phone,
      website: o.website,
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `${hits[0].name} | ${String(hits[0].address || '').slice(0, 160)}`,
    };
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
      excerpt: 'the handler threw: ' + String(e).slice(0, 200) };
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause before answering lets the finished HTTP socket close: on Windows with Node 24 the runner's
 * process.exit() right after a fetch aborts with a libuv assertion (exit 127) unless the socket has settled.
 */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await run(keyword);
  } catch (e) {
    answer = { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
      excerpt: 'the handler threw: ' + String(e).slice(0, 200) };
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}
