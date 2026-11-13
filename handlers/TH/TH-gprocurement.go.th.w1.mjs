export const meta = {
  task: 'TH-gprocurement.go.th',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'operator_type', 'tax_id', 'blacklist_id', 'contract_id', 'circular_no', 'circular_file'],
  canary: { found: 'บริษัท คาซ่า เอ็นจิเนียริ่ง เพาเวอร์ จำกัด', not_found: 'บริษัท ทดสอบไม่มีอยู่จริง จำกัด' },
};

const FORM_PAGE = 'https://process3.gprocurement.go.th/BlackListWeb/jsp/BLK1300N.jsp?showMode=direct';
const SEARCH_URL = 'https://process3.gprocurement.go.th/BlackListWeb/jsp/control.blacklist';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** The site reads form data as TIS-620 (windows-874). Encode a string as percent-encoded TIS-620 bytes.
 *  Returns null when a character cannot be written in TIS-620 (the site could not match it anyway). */
function encodeTis620(str) {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out += /[A-Za-z0-9*._-]/.test(ch) ? ch : '%' + hex2(cp);
    } else if (cp >= 0x0e01 && cp <= 0x0e5b) {
      out += '%' + hex2(cp - 0x0e00 + 0xa0);
    } else {
      return null;
    }
  }
  return out;
}

/** Decode the TIS-620 / windows-874 bytes of the result page. */
function decodeTis620(bytes) {
  try {
    return new TextDecoder('windows-874').decode(bytes);
  } catch {
    let s = '';
    for (const b of bytes) {
      if (b < 0x80) s += String.fromCharCode(b);
      else if (b >= 0xa1 && b <= 0xfb) s += String.fromCharCode(b - 0xa0 + 0x0e00);
      else s += '?';
    }
    return s;
  }
}

/** Compare names without spaces, punctuation, case or legal form (บริษัท / จำกัด / มหาชน, Co., Ltd., Sdn Bhd ...). */
function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b(co|ltd|sdn|bhd|inc|corp|limited|company|public|plc|pcl)\b/g, '')
    .replace(/ห้างหุ้นส่วนสามัญนิติบุคคล|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|บริษัท|จำกัด|มหาชน/g, '')
    .replace(/[\s,\-_()\/&'"]+/g, '');
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse the rows of the result table (page 1 only; the site shows 10 rows per page). */
function parseRows(html) {
  const rows = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const link = tr.match(/linkName\('([^']*)','([^']*)','([^']*)','([^']*)'\)/);
    if (!link) continue;
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map((td) => cleanText(td));
    rows.push({
      blacklist_id: link[1],
      name: link[2],
      contract_id: link[4],
      operator_type: cells[1] || '',
      tax_id: cells[2] || '',
      circular_no: cells[3] || '',
      circular_file: cells[5] || '',
      text: cleanText(tr),
    });
  }
  return rows;
}

/** Total shown by the site: "จากทั้งหมด 3 รายการ" or "จากทั้งหมด มากกว่า 50 รายการ" (lower bound). */
function parseTotal(text) {
  const m = text.match(/จากทั้งหมด\s*(มากกว่า\s*)?([\d,]+)\s*รายการ/) || text.match(/ข้อมูลทั้งหมด\s*([\d,]+)\s*รายการ/);
  if (!m) return null;
  const digits = m[2] !== undefined ? m[2] : m[1];
  return { n: Number(String(digits).replace(/,/g, '')), lowerBound: m[2] !== undefined && !!m[1] };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const r = await lookupInner(keyword);
  // Let the socket close before the worker process exits (Node 24 on Windows aborts on exit with an open socket).
  await new Promise((done) => setTimeout(done, 500));
  return r;
}

async function lookupInner(keyword) {
  const kw = String(keyword || '').trim().replace(/\s+/g, ' ');
  const kwNorm = normName(kw);
  const sourceUrl = FORM_PAGE;
  try {
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'empty company name' };
    }
    const encName = encodeTis620(kw);
    if (encName === null) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
        excerpt: 'the name has characters the site cannot take (not Thai, English or basic punctuation)' };
    }

    const body = [
      'mode=SEARCH', 'servlet=BLK1300NServlet', 'proc_id=BLK1300N', 'processFlows=blacklist', 'proc_name=blacklist',
      'S_blacklistName=' + encName, 'S_blacklistTin=', 'S_blacklistPin=', 'S_blacklistJurNo=', 'S_blacklistBoard=',
      'S_blacklistTitle=', 'showMode=direct', 'url=agc/', 'beginMaster=', 'endMaster=', 'beginDetail=', 'endDetail=',
      'pageNo=', 'beginrec=', 'endrec=',
    ].join('&');

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': FORM_PAGE,
        'Connection': 'close',
      },
      body,
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = decodeTis620(new Uint8Array(await res.arrayBuffer()));
    const text = cleanText(html);

    if (/rejected|access denied|captcha/i.test(text) && !/ข้อมูลทั้งหมด|จากทั้งหมด|E8501/.test(text)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: text.slice(0, 300) };
    }

    const isResultPage = /ข้อมูลทั้งหมด|จากทั้งหมด|E8501|รายการผู้ทิ้งงาน/.test(text);
    if (!isResultPage) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: text.slice(0, 300) };
    }

    const rows = parseRows(html);
    const total = parseTotal(text);
    const notFoundMsg = /E8501|ไม่พบ/.test(text);

    const exact = rows.filter((r) => normName(r.name) === kwNorm);
    if (exact.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: exact.map((r) => ({
          name: r.name,
          operator_type: r.operator_type,
          tax_id: r.tax_id,
          blacklist_id: r.blacklist_id,
          contract_id: r.contract_id,
          circular_no: r.circular_no,
          circular_file: r.circular_file,
        })),
        source_url: sourceUrl,
        excerpt: exact[0].text.slice(0, 500),
      };
    }

    if (rows.length === 0) {
      if ((total && total.n === 0) || notFoundMsg) {
        return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: 'site returned 0 results for this name' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: text.slice(0, 300) };
    }

    if (!total) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: text.slice(0, 300) };
    }
    if (total.n > rows.length || total.lowerBound) {
      // More matches exist than page 1 shows, and none on page 1 is this company: do not say "not found".
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl,
        excerpt: `site shows ${total.lowerBound ? 'more than ' : ''}${total.n} results; none of the ${rows.length} on page 1 is this company, later pages not read` };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `${rows.length} similar result(s), none is this company: ${rows.map((r) => r.name).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
