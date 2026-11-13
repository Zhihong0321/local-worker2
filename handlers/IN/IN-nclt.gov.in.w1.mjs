export const meta = { task: 'IN-nclt.gov.in', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'filing_no', 'case_no', 'case_type', 'bench', 'status', 'filing_date', 'next_listing_date', 'party_role', 'case_title1', 'case_title2'],
  canary: { found: 'RELIANCE DEFENCE SYSTEMS PRIVATE LIMITED', not_found: 'Zqxwvq Nonexistent Holdings' } };

// eFiling "Case History" page, Party Name tab (public, no login, no captcha). The page's own JavaScript posts this JSON.
const PAGE_URL = 'https://efiling.nclt.gov.in/casehistorybeforeloginmenutrue.drt';
const SEARCH_URL = 'https://efiling.nclt.gov.in/caseHistoryoptional.drt';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': PAGE_URL,
  'Origin': 'https://efiling.nclt.gov.in',
};

// Bench values of the form's "Zonal Bench" select (id_i_bench_id_party). The form lists value 10 twice
// (Principal Bench and New Delhi Bench), so it is searched once. The bench is required by the form: one request per bench.
const BENCHES = ['10', '9', '13', '1', '12', '4', '8', '11', '3', '5', '6', '7', '14', '15', '2'];

// Legal-form words stripped from the end of a name before comparing (case, punctuation and legal form ignored).
const LEGAL_TAIL = ['private', 'pvt', 'limited', 'ltd', 'llp', 'company', 'co'];

function core(name) {
  const words = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean);
  while (words.length && LEGAL_TAIL.includes(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function failure(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt || '').slice(0, 300) };
}

function reasonOf(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

async function searchBench(benchId, term) {
  const bean = {
    wayofselection: 'partyname', i_bench_id: '0', filing_no: '', i_bench_id_case_no: '0', i_case_type_caseno: '0',
    i_case_year_caseno: '0', case_no: '', i_party_search: 'W', i_bench_id_party: benchId, party_type_party: '0',
    party_name_party: term, i_case_year_party: '0', status_party: '0', i_adv_search: '', i_bench_id_lawyer: '0',
    party_lawer_name: '', i_case_year_lawyer: '0', bar_council_advocate: '',
  };
  try {
    const res = await fetch(SEARCH_URL, { method: 'POST', headers: HEADERS, body: JSON.stringify(bean), signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { reason: 'layout_changed', excerpt: text.slice(0, 200) }; }
    if (!json || typeof json !== 'object' || !('caseHheader' in json)) return { reason: 'layout_changed', excerpt: text.slice(0, 200) };
    if (Array.isArray(json.mainpanellist)) return { rows: json.mainpanellist };
    // The site's own "no result" answer: mainpanellist null with this message. Anything else is not trusted as "not found".
    if (json.errormsg && /no details are find out/i.test(json.errormsg)) return { rows: [] };
    return { reason: 'layout_changed', excerpt: String(json.errormsg || 'no mainpanellist').slice(0, 200) };
  } catch (err) {
    return { reason: reasonOf(err), excerpt: String(err && err.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword ?? '').trim();
    // The site's search was not verified for non-Latin script, so such names are not reported as not_found.
    if (/[^\x00-\x7F]/.test(input)) return failure('other', 'name is not in Latin script; this site search was not verified for it');
    const term = core(input);
    if (term.length < 3) return failure('other', 'name is too short for the site search (min 3 characters)');
    const wanted = core(input);

    const results = await Promise.all(BENCHES.map(async (id) => ({ id, ...(await searchBench(id, term)) })));

    const records = [];
    const benchesWithHits = new Set();
    const failed = [];
    for (const r of results) {
      if (r.reason) { failed.push(r); continue; }
      for (const row of r.rows) {
        for (const [role, title] of [['title1', row.case_title1], ['title2', row.case_title2]]) {
          const parts = String(title || '').split(/\s+vs\.?\s+/i);
          const hit = parts.some((p) => core(p) === wanted);
          if (!hit) continue;
          benchesWithHits.add(r.id);
          records.push({
            name: String(title).trim(), filing_no: row.filing_no, case_no: row.case_no, case_type: row.case_type_desc_cis,
            bench: row.bench_location_name, status: row.status, filing_date: row.date_of_filing,
            next_listing_date: row.next_list_date, party_role: role,
            case_title1: String(row.case_title1 || '').trim(), case_title2: String(row.case_title2 || '').trim(),
          });
        }
      }
    }

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: PAGE_URL,
        excerpt: `${records.length} case row(s) with this party name on ${benchesWithHits.size} bench(es)` +
          (failed.length ? `; ${failed.length} bench(es) could not be checked` : ''),
      };
    }
    if (failed.length) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      const worst = failed.slice().sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
      return failure(worst.reason, `${failed.length} of ${BENCHES.length} benches could not be checked; first: bench ${worst.id} ${worst.excerpt}`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
      excerpt: `no party-name match on any of ${BENCHES.length} benches` };
  } catch (err) {
    return failure('other', String(err && err.message || err));
  }
}
