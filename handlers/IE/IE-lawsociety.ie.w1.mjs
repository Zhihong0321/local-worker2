export const meta = { task: 'IE-lawsociety.ie', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'firm_id', 'firm_type', 'address', 'county', 'eircode', 'telephone', 'email', 'website',
    'pii_covered', 'pii_amount', 'pii_valid_from', 'pii_valid_to', 'pii_insurers', 'previous_names'],
  canary: { found: 'McCann FitzGerald LLP', not_found: 'Comhlacht Neamhfhíoraithe Teoranta' } };

// Law Society of Ireland, "Find a Solicitor" > "Solicitor Firm Search" page (/find-a-solicitor/Solicitor-Firm-Search/).
// That page's own script calls GET /UniversalSearch/GetSearchResults with these query parameters and renders the JSON.
// Firm results come back 10 per page; totalPages tells how many pages exist.
const BASE = 'https://www.lawsociety.ie';
const PAGE_ID = '154320'; // the search page's own currentPageId (hidden input on the page)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SCAN_BUDGET_MS = 40000; // keep the whole call well under the 60 s limit
const LEGAL_FORMS = new Set(['llp', 'ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'unlimited', 'co', 'company',
  'cuideachta', 'designated', 'activity']);

/** Compare names: no case, accents, punctuation or spaces, and no trailing legal form (LLP, Ltd, Teoranta ...). */
function normName(s) {
  const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const parts = t ? t.split(' ') : [];
  while (parts.length && LEGAL_FORMS.has(parts[parts.length - 1])) parts.pop();
  return parts.join('');
}

function searchUrl(keyword, pageNo) {
  const p = new URLSearchParams({
    pageId: PAGE_ID, txtSearchNameLocation: keyword, ddLookingFor: 'Firm', ddlCounty: '', ddLocatedIn: '',
    ddPractisingStatus: '', ddOrganisationType: '', cbIncludeFirmsAbroad: 'false', ddFirmOrganisationType: '',
    ddFirmPublicOrganisation: '', ddSortBy: '', ddMediatorLocatedIn: '', ddPracticeArea: '',
    cbOffersRemoteMediation: 'false', pageNo: String(pageNo), viewAll: 'false',
  });
  return `${BASE}/UniversalSearch/GetSearchResults?${p.toString()}`;
}

const dateOnly = (d) => (!d || String(d).startsWith('0001-') ? '' : String(d).slice(0, 10));

function toRecord(f) {
  const address = [f.address1, f.address2, f.address3, f.address4, f.address5, f.postCode]
    .map((x) => (x || '').trim()).filter(Boolean).join(', ');
  return {
    name: f.firmName || '',
    firm_id: f.id || '',
    firm_type: f.firmType || '',
    address,
    county: f.countySort || '',
    eircode: f.eircode || '',
    telephone: f.telephone1 || '',
    email: f.emailAddress || '',
    website: f.webAddress || '',
    pii_covered: !!f.piiCovered,
    pii_amount: f.piiCovered ? (f.piiAmount || '') : '',
    pii_valid_from: dateOnly(f.piiFromDate),
    pii_valid_to: dateOnly(f.piiToDate),
    pii_insurers: (f.piiInsurers || []).map((i) => i.insurerName).filter(Boolean),
    previous_names: f.previousFirmNames || '',
  };
}

/** One search page. Returns { fail } with a couldnt_check reason, or { data } with the parsed JSON. */
async function getPage(keyword, pageNo) {
  let res;
  try {
    res = await fetch(searchUrl(keyword, pageNo), {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${BASE}/find-a-solicitor/Solicitor-Firm-Search/`,
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: { reason: timeout ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) } };
  }
  if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || typeof data !== 'object' || !('firmSearchResults' in data) || !('divNoResultsVisible' in data)) {
    if (/captcha|are you a robot|access denied|verify you are human/i.test(text.slice(0, 5000))) {
      return { fail: { reason: 'blocked', excerpt: text.slice(0, 200) } };
    }
    return { fail: { reason: 'layout_changed', excerpt: text.slice(0, 200) } };
  }
  return { data };
}

const cc = (reason, excerpt, source_url) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const source_url = searchUrl(name, 1);
  try {
    const target = normName(name);
    if (!target) return cc('other', 'empty company name', source_url);

    const first = await getPage(name, 1);
    if (first.fail) return cc(first.fail.reason, first.fail.excerpt, source_url);

    const matches = [];
    const seenNames = [];
    let totalPages = Number(first.data.totalPages) || 0;
    let page = 1;
    let data = first.data;
    let stoppedEarly = '';

    while (true) {
      const list = Array.isArray(data.firmSearchResults) ? data.firmSearchResults : [];
      for (const f of list) {
        if (seenNames.length < 5) seenNames.push(f.firmName);
        if (normName(f.firmName) === target) matches.push(f);
      }
      if (page >= totalPages) break;
      if (Date.now() - started > SCAN_BUDGET_MS) { stoppedEarly = `stopped after page ${page} of ${totalPages}`; break; }
      page += 1;
      const next = await getPage(name, page);
      if (next.fail) {
        if (matches.length) break; // the match is already in hand
        return cc(next.fail.reason, `page ${page}: ${next.fail.excerpt}`, source_url);
      }
      data = next.data;
    }

    if (matches.length) {
      const records = matches.map(toRecord);
      const r = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url,
        excerpt: `${r.name} | ${r.address} | ${r.telephone}`.slice(0, 500),
      };
    }

    if (stoppedEarly) return cc('other', `no exact match on the pages read; ${stoppedEarly}`, source_url);

    // Every page was read and none of them is this company.
    if (!seenNames.length && !first.data.divNoResultsVisible) {
      return cc('layout_changed', 'empty result without the site\'s no-results marker', source_url);
    }
    const shown = seenNames.length ? `site returned: ${seenNames.join('; ')}` : 'site returned 0 firm results';
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: `No firm named "${name}" on the site. ${shown}`.slice(0, 500),
    };
  } catch (err) {
    return cc('other', String(err?.message || err).slice(0, 300), source_url);
  }
}
