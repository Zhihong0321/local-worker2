// CIDB local contractor search. A GET does not run the query; the form POSTs
// to itself, then each row's Paparan link opens reglocalsearch_view.vbhtml.
export const meta = {
  task: 'MY-cidb.gov.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'grade', 'state', 'district', 'phone', 'ppk', 'spkk', 'stb', 'ppk_no', 'ppk_valid_until', 'categories', 'specializations', 'has_b04', 'has_b28'],
  canary: { found: 'DEZENO SDN. BHD.', not_found: 'Kingdom Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SEARCH = 'https://cims.cidb.gov.my/smis/regcontractor/reglocalsearchcontractor.vbhtml';
const VIEW = 'https://cims.cidb.gov.my/smis/regcontractor/reglocalsearch_view.vbhtml';

const STOP = new Set(['SDN', 'BHD', 'MALAYSIA', 'THE', 'AND', 'ENTERPRISE', 'COMPANY']);

function couldnt(reason, source_url, excerpt) {
  return {
    status: 'couldnt_check',
    reason,
    records: [],
    source_url,
    excerpt: String(excerpt || '').replace(/\s+/g, ' ').slice(0, 500),
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function textOf(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return decodeEntities(s)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\b(SDN\.?\s*BHD\.?|SENDIRIAN BERHAD|BERHAD|BHD\.?|PLT\.?)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
}

function wholeWord(hay, needle) {
  return new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(hay);
}

function matches(keyword, title) {
  const a = norm(keyword);
  const b = norm(title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 5 && (b.includes(a) || (b.length >= 5 && a.includes(b)))) return true;
  const ta = tokens(keyword);
  if (!ta.length || !ta.every((t) => wholeWord(b, t))) return false;
  return ta.length >= 2 || ta[0].length >= 4;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function takeCookie(res, prev) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const map = new Map();
  for (const part of String(prev || '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf('=');
    if (i > 0) map.set(p.slice(0, i), p.slice(i + 1));
  }
  for (const c of set) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

async function getText(url, cookie) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  return { res, text, cookie: takeCookie(res, cookie) };
}

function classify(res, text) {
  const head = text.slice(0, 700);
  if (
    res.status === 401 || res.status === 403 || res.status === 429 ||
    /cf-browser-verification|just a moment|captcha|attention required/i.test(head)
  ) return 'blocked';
  if (!res.ok) return 'http_error';
  return '';
}

function parseRows(html) {
  const table = html.match(/<table[^>]*id="tblList1"[\s\S]*?<\/table>/i);
  if (!table) return [];
  const body = table[0].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!body) return [];
  const rows = [];
  for (const tr of body[1].matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => textOf(c[1]));
    if (cells.length < 10 || !cells[1]) continue;
    const flag = (tr[0].match(/data-flag="([^"]+)"/i) || [])[1] || '';
    rows.push({
      name: cells[1],
      grade: cells[2],
      state: cells[3],
      district: cells[4],
      phone: cells[5],
      fax: cells[6],
      ppk: cells[7],
      spkk: cells[8],
      stb: cells[9],
      detail_id: flag,
    });
  }
  return rows;
}

function parseDetail(html) {
  if (!/Registration Grade And Category/i.test(html) || !/>Name</i.test(html)) return null;
  const name = (html.match(/Name<\/th>\s*<th>\s*<b>([\s\S]*?)<\/b>/i) || [])[1];
  const ppkNo = (html.match(/PPK Registration No<\/th>\s*<th>([\s\S]*?)<\/th>/i) || [])[1];
  const member = (html.match(/Member Since<\/th>\s*<th>([\s\S]*?)<\/th>/i) || [])[1];
  const ppkRow = html.match(/PERAKUAN PENDAFTARAN KONTRAKTOR \(PPK\)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/i);
  const block = html.match(/Registration Grade And Category[\s\S]*?<table[\s\S]*?<\/table>/i);
  const categories = [];
  const specs = [];
  if (block) {
    for (const tr of block[0].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => textOf(c[1]));
      if (tds.length < 3) continue;
      if (tds[1]) categories.push(tds[0] + ' ' + tds[1]);
      const codes = [...tr[1].matchAll(/\b([A-Z]{1,3}\d{2})\s*\(([^)<]+)\)/g)];
      for (const c of codes) specs.push(c[1] + ' (' + textOf(c[2]) + ')');
    }
  }
  return {
    name: textOf(name || ''),
    ppk_no: textOf(ppkNo || ''),
    member_since: textOf(member || ''),
    ppk_start: ppkRow ? textOf(ppkRow[1]) : '',
    ppk_valid_until: ppkRow ? textOf(ppkRow[2]) : '',
    categories: [...new Set(categories)].join('; '),
    specializations: specs.join('; '),
    has_b04: specs.some((s) => s.startsWith('B04 ')) ? 'yes' : 'no',
    has_b28: specs.some((s) => s.startsWith('B28 ')) ? 'yes' : 'no',
  };
}

export default async function lookup(keyword) {
  try {
    const q = String(keyword ?? '').trim();
    if (!q) return couldnt('other', SEARCH, 'empty keyword');
    if (!norm(q)) return couldnt('other', SEARCH, 'keyword has no distinctive name');

    let opened = await getText(SEARCH, '');
    let why = classify(opened.res, opened.text);
    if (why) return couldnt(why, SEARCH, 'HTTP ' + opened.res.status + ' ' + opened.text.slice(0, 240));
    if (!/id="comName"/i.test(opened.text) || !/Nama Kontraktor|Contractor Name/i.test(opened.text)) {
      return couldnt('layout_changed', SEARCH, opened.text.slice(0, 300));
    }

    await sleep(1100);
    const all = [];
    let total = null;
    let page = 1;
    let pages = 1;
    let cookie = opened.cookie;
    while (page <= pages && page <= 4) {
      const body = new URLSearchParams({
        comName: q,
        ComState: '',
        ComCategoryID: '',
        CidbRegno: '',
        ComDistrict: '',
        ComSpecID: '',
        ComGradeID: '',
        seltype: '1',
        selvalidity: '1',
        ssmno: '',
        hdnpagesize: '100',
        hdnctpage: String(page),
        hdntotpage: '0',
        hdnsortcol: 'ComName',
        hdnsortdir: '0',
        hdntotalrecs: '0',
        hdnexportopts: '0',
      });
      const res = await fetch(SEARCH, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      cookie = takeCookie(res, cookie);
      why = classify(res, text);
      if (why) return couldnt(why, SEARCH, 'HTTP ' + res.status + ' ' + text.slice(0, 240));
      const echo = text.match(/name="comName"[^>]*value="([^"]*)"/i);
      if (!echo || norm(decodeEntities(echo[1])) !== norm(q)) {
        return couldnt('layout_changed', SEARCH, 'search form did not echo the company name');
      }
      if (!/id="tblList1"/i.test(text) || !/Nama Kontraktor/i.test(text)) {
        return couldnt('layout_changed', SEARCH, 'result table missing');
      }
      const tot = text.match(/Jumlah Rekod:\s*(\d+)/i);
      const tp = text.match(/name="hdntotpage"[^>]*value="(\d+)"/i);
      if (!tot || !tp) return couldnt('layout_changed', SEARCH, 'record count missing');
      total = Number(tot[1]);
      pages = Math.max(1, Number(tp[1]));
      all.push(...parseRows(text));
      if (page < pages) await sleep(1100);
      page++;
    }

    if (total === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH,
        excerpt: 'CIDB local valid-contractor search for "' + q.slice(0, 140) + '" returned Jumlah Rekod: 0.',
      };
    }
    if (pages > 4 && all.length < total) {
      // Still filter what we have; if nothing matched, do not claim absence.
    }
    const hits = all.filter((row) => matches(q, row.name));
    if (!hits.length) {
      if (pages > 4 && all.length < total) {
        return couldnt('other', SEARCH, 'Search returned ' + total + ' rows and the name was not in the first 4 pages.');
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH,
        excerpt: 'No contractor name matched "' + q.slice(0, 140) + '" among ' + total + ' CIDB rows.',
      };
    }

    const records = [];
    const limited = hits.slice(0, 3);
    for (let i = 0; i < limited.length; i++) {
      const row = limited[i];
      const rec = {
        name: row.name,
        grade: row.grade,
        state: row.state,
        district: row.district,
        phone: row.phone,
        ppk: row.ppk,
        spkk: row.spkk,
        stb: row.stb,
        ppk_no: '',
        ppk_valid_until: '',
        categories: '',
        specializations: '',
        has_b04: '',
        has_b28: '',
      };
      if (row.detail_id) {
        await sleep(1100);
        const url = VIEW + '?search=P&comSSMNo=' + encodeURIComponent(row.detail_id);
        const detail = await getText(url, cookie);
        cookie = detail.cookie;
        const bad = classify(detail.res, detail.text);
        if (!bad) {
          const parsed = parseDetail(detail.text);
          if (parsed) Object.assign(rec, {
            ppk_no: parsed.ppk_no,
            ppk_valid_until: parsed.ppk_valid_until,
            categories: parsed.categories,
            specializations: parsed.specializations,
            has_b04: parsed.has_b04,
            has_b28: parsed.has_b28,
          });
        }
      }
      records.push(rec);
    }
    for (const row of hits.slice(3)) {
      records.push({
        name: row.name,
        grade: row.grade,
        state: row.state,
        district: row.district,
        phone: row.phone,
        ppk: row.ppk,
        spkk: row.spkk,
        stb: row.stb,
        ppk_no: '',
        ppk_valid_until: '',
        categories: '',
        specializations: '',
        has_b04: '',
        has_b28: '',
      });
    }
    const top = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: SEARCH,
      excerpt: [top.name, top.grade, top.state, top.ppk_no, top.ppk_valid_until, top.specializations].filter(Boolean).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const reason = /timeout|aborted|ETIMEDOUT/i.test(String(err?.message || err)) ? 'timeout' : 'other';
    return couldnt(reason, SEARCH, err?.message || err);
  }
}
