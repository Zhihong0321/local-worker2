export const meta = {
  task: 'MY-jtksm.mohr.gov.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_no', 'licence_category', 'ssm_no', 'start_date', 'end_date', 'address', 'state', 'district', 'contact', 'status'],
  canary: { found: 'AGENSI PEKERJAAN & LATIHAN TAPRO SDN. BHD.', not_found: 'SYARIKAT KHAYALAN TIADA LESEN SDN BHD' },
};

// The APS register page (jtksm.gov.my/aps-directory/aps.html) shows the rows of this Google Sheet.
// The page reads the sheet live when it opens; this handler reads the same sheet, the same tab.
const SHEET_ID = '1VR_vVb0YeuSxAS8qGgi82DoyL75YU-ypbCHihPPOqYU';
const SHEET_GID = '414969700';
const PAGE_URL = 'https://jtksm.gov.my/aps-directory/aps.html';
const CALLBACK = 'jtksmAps';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EXPECTED_HEADERS = ['Nama Agensi', 'No. Lesen', 'Kategori Lesen', 'No. SSM', 'Tarikh Mula', 'Tarikh Tamat', 'Countdown', 'Alamat', 'Negeri', 'Daerah', 'E-mel & No. Telefon', 'Status'];

/**
 * Compare-key for a company name: upper case, "&" = "DAN", punctuation removed, legal form (SDN BHD, BHD, BERHAD, PLT)
 * removed, and a trailing branch marker "(CAWANGAN 1)" / "CABANG" / "BRANCH" removed. Applied to the keyword and to the
 * register, so "Tapro Sdn. Bhd." and "TAPRO SDN BHD" give the same key.
 */
function normalize(raw) {
  let s = String(raw || '').toUpperCase();
  s = s.replace(/\((CAWANGAN|CABANG|BRANCH)[^)]*\)/g, ' ');
  s = s.replace(/\b(CAWANGAN|CABANG|BRANCH)\s*\d*\s*$/g, ' ');
  s = s.replace(/&/g, ' DAN ');
  s = s.replace(/[^A-Z0-9]+/g, ' ');
  s = s.replace(/\b(SDN|BHD|BERHAD|PLT)\b/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function cell(row, i) {
  const c = row.c && row.c[i];
  if (!c) return '';
  const v = c.f !== undefined && c.f !== null ? c.f : c.v;
  return v === null || v === undefined ? '' : String(v).replace(/\s*\n\s*/g, ' / ').trim();
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalize(keyword);
    if (!key) {
      return fail('couldnt_check', 'other', PAGE_URL, 'the keyword has no company name left after removing the legal form');
    }

    const params = new URLSearchParams({ headers: '1', tqx: `out:json;responseHandler:${CALLBACK}`, gid: SHEET_GID });
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return fail('couldnt_check', 'blocked', PAGE_URL, `HTTP ${res.status} from the register data`);
    }
    if (!res.ok) {
      return fail('couldnt_check', 'http_error', PAGE_URL, `HTTP ${res.status} from the register data`);
    }

    const text = await res.text();
    const m = text.match(new RegExp(`${CALLBACK}\\(([\\s\\S]*)\\);?\\s*$`));
    if (!m) {
      return fail('couldnt_check', 'layout_changed', PAGE_URL, 'register data did not come back in the expected form: ' + text.slice(0, 200));
    }

    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return fail('couldnt_check', 'layout_changed', PAGE_URL, 'register data is not valid JSON');
    }
    if (!data || data.status !== 'ok' || !data.table || !Array.isArray(data.table.rows) || !Array.isArray(data.table.cols)) {
      return fail('couldnt_check', 'other', PAGE_URL, 'register data returned status ' + (data && data.status));
    }

    const headers = data.table.cols.slice(0, EXPECTED_HEADERS.length).map((c) => String(c.label || '').trim());
    if (EXPECTED_HEADERS.some((h, i) => headers[i] !== h)) {
      return fail('couldnt_check', 'layout_changed', PAGE_URL, 'register columns changed: ' + headers.join(' | '));
    }

    const rows = data.table.rows.filter((r) => cell(r, 0) !== '');
    const records = [];
    for (const r of rows) {
      const name = cell(r, 0);
      if (normalize(name) !== key) continue;
      records.push({
        name,
        licence_no: cell(r, 1),
        licence_category: cell(r, 2),
        ssm_no: cell(r, 3),
        start_date: cell(r, 4),
        end_date: cell(r, 5),
        address: cell(r, 7),
        state: cell(r, 8),
        district: cell(r, 9),
        contact: cell(r, 10),
        status: cell(r, 11),
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: `No row of the APS register (${rows.length} rows read live) matches "${keyword}".`,
      };
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE_URL,
      excerpt: `${records.length} APS register row(s) for "${keyword}". First: ${first.name} | licence ${first.licence_no} | category ${first.licence_category} | ${first.status} | ${first.start_date} to ${first.end_date}`,
    };
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return fail('couldnt_check', 'timeout', PAGE_URL, 'the register data did not answer within 25 s');
    }
    return fail('couldnt_check', 'other', PAGE_URL, String((err && err.message) || err));
  }
}
