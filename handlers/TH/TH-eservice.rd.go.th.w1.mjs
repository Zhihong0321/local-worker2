export const meta = {
  task: 'TH-eservice.rd.go.th',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'tax_id', 'branch', 'title', 'approve_date', 'close_date', 'approve_status', 'status', 'reason_close', 'address'],
  canary: { found: 'บริษัท ซีพี ออลล์ จำกัด (มหาชน)', not_found: 'บริษัท ไม่มีชื่อนี้ทดสอบ จำกัด' },
};

// The "Domestic VAT registrants" page (rd-ves-web) calls this JSON API with the name AES-encrypted by the page's own
// key and IV. Public, no login, no captcha. The search matches part of the company name and returns at most 1000 rows.
const BASE = 'https://eservice.rd.go.th/rd-ves-service/vesweb';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const AES_KEY = 'V7wfrGb5XJDgdfs3';
const AES_IV = 'DwDvDB1fJlNKIlPt';
const ROW_CAP = 1000;

// Legal-form and title words. Removed before comparing, so "บริษัท X จำกัด (มหาชน)" and "X" compare equal.
const LEGAL_RE = /ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|นิติบุคคล|บริษัท|จำกัด|มหาชน/g;
const LEGAL_WORDS = new Set(['co', 'ltd', 'limited', 'plc', 'pcl', 'public', 'company', 'corp', 'inc']);

/** The name split into words with the legal form removed, case kept (the search is case-sensitive to the typed text). */
function words(name) {
  return String(name || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .split(' ')
    .map((w) => w.replace(LEGAL_RE, ''))
    .filter((w) => w && !LEGAL_WORDS.has(w.toLowerCase()));
}

/** Comparison key: lowercase, no spaces, no legal form. */
function key(name) {
  return words(name).join('').toLowerCase();
}

async function encryptForSite(text) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(AES_KEY), { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: enc.encode(AES_IV) }, k, enc.encode(text)));
  let bin = '';
  for (const b of ct) bin += String.fromCharCode(b);
  return encodeURIComponent(btoa(bin));
}

function formatAddress(a) {
  if (!a) return '';
  const parts = [a.addNo, a.building, a.floorNo, a.roomNo, a.village, a.mooNo, a.soiName, a.yaek, a.thnName,
    a.tamName, a.ampName, a.provName, a.postCode];
  return parts.map((p) => String(p || '').trim()).filter((p) => p && p !== '-').join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Node on Windows can abort at process exit (libuv assertion, exit 127) right after a small keep-alive response
  // is read. A short pause before returning lets the socket settle. Reproduced with a bare fetch script too.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return answer;
}

async function search(keyword) {
  let source_url = '';
  try {
    const query = words(keyword).join(' ');
    if (!query) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'no name left after removing the legal form' };
    }
    source_url = `${BASE}/search/vatRegistrantsIn/2?braNam=${await encryptForSite(query)}`;

    let res;
    try {
      res = await fetch(source_url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url, excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (!text.trimStart().startsWith('[')) {
      const blocked = /captcha|access denied|forbidden/i.test(text);
      return { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
    }
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
    }
    if (!Array.isArray(rows)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
    }

    const want = key(keyword);
    const matches = rows.filter((r) => key(r?.firstName) === want);

    if (matches.length === 0) {
      if (rows.length >= ROW_CAP) {
        // The site stops at 1000 rows, so the company could be past the cap. Not proof that it is absent.
        return { status: 'couldnt_check', reason: 'other', records: [], source_url,
          excerpt: `search for "${query}" hit the ${ROW_CAP}-row cap with no exact name match` };
      }
      return { status: 'not_found', reason: '', records: [], source_url,
        excerpt: `search for "${query}" returned ${rows.length} row(s), none with this name` };
    }

    const records = matches.map((r) => ({
      name: [r.titleCode, r.firstName].map((p) => String(p || '').trim()).filter(Boolean).join(' '),
      tax_id: r.nid || '',
      branch: r.branchNo || '',
      title: r.titleCode || '',
      approve_date: r.approveDate || '',
      close_date: r.closeDate || '',
      approve_status: r.approveStatus || '',
      status: r.status || '',
      reason_close: r.reasonClose || '',
      address: formatAddress(r.addressInformation),
    }));
    const capNote = rows.length >= ROW_CAP ? ' (site cap of 1000 rows reached: branch list may be incomplete)' : '';
    return {
      status: 'found',
      reason: '',
      records,
      source_url,
      excerpt: `${records.length} row(s) with this name, tax ID ${records[0].tax_id}${capNote}`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
