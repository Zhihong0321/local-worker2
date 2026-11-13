// bizSAFE Status Check (WSHC). The public page www.tal.sg/wshc links to bizsafe.wshc.sg/status-check, a Power Pages
// portal. Its page calls the portal's anonymous Dataverse Web API (GET /_api/incidents?fetchXml=...) with the same
// fetchXML the page uses for "company name" search. This handler sends that query and matches names exactly after
// normalising case, punctuation and legal form.
export const meta = { task: 'SG-tal.sg', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'bizsafe_level', 'application_category', 'bizsafe_status', 'submission_date', 'approval_date',
    'expiry_date', 'returned_on', 'withdrawn_date', 'revocation_end_date', 'termination_end_date'],
  canary: { found: '@BSOLUTE CLEANING PTE. LTD.', not_found: '新加坡不存在公司有限公司' } };

const API = 'https://bizsafe.wshc.sg/_api/incidents';
const PAGE_URL = 'https://bizsafe.wshc.sg/status-check';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = ['pte', 'ltd', 'limited', 'sdn', 'bhd', 'llp', 'llc', 'inc', 'corp', 'corporation', 'co', 'company', 'private', 'plc'];
const MAX_PAGES = 5;
const DEADLINE_MS = 40000;

// Words of the legal form, removed from the search text (the site search is "contains").
function searchText(keyword) {
  const re = new RegExp(`\\b(${LEGAL_FORMS.join('|')})\\b\\.?`, 'gi');
  return String(keyword || '').normalize('NFKC').replace(re, ' ').replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Name for matching: lower case, letters and digits only, no legal form words.
function nameKey(str) {
  const words = String(str || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean)
    .filter((w) => !LEGAL_FORMS.includes(w));
  return words.join('');
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/</g, '&lt;');
}

// The same fetchXML as the portal's status-check query (mapping logical, all statuses except draft/rejected ones).
function buildFetch(page, count, text) {
  const like = text ? `<condition attribute="ave_bizsafeappcompanyguidname" operator="like" value="%${xmlEscape(text.replace(/&/g, '&amp;'))}%"/>` : '';
  return `<fetch mapping="logical" no-lock="false" returntotalrecordcount="true" count="${count}" page="${page}">` +
    `<entity name="incident">` +
    `<attribute name="incidentid"/><attribute name="ave_bizsafeappcompanyguid"/>` +
    `<attribute name="ave_bizsafeappsubmissiondate"/><attribute name="ave_bizsafeappapprovaldate"/>` +
    `<attribute name="ave_bizsafeappexpirydate"/><attribute name="ave_bizsafeapplevelcode"/>` +
    `<attribute name="ave_bizsafeappreturnedondate"/><attribute name="ave_bizsafeappwithdrawndate"/>` +
    `<attribute name="ave_bizsafeappsuspensionenddate"/><attribute name="ave_bizsafeappterminationenddate"/>` +
    `<attribute name="ave_bizsafeappapplicationcategorycode"/><attribute name="ave_bizsafeapplicationenterprisestatuscode"/>` +
    `<attribute name="ave_bizsafeappcompanyguidname"/>` +
    `<filter type="and">` +
    `<condition attribute="ave_bizsafepplicationstatuscode" operator="ne" value="900000000"/>` +
    `<condition attribute="ave_bizsafeappapplicationcategorycode" operator="ne" value="900000002"/>` +
    `<condition attribute="ave_bizsafepplicationstatuscode" operator="not-null"/>` +
    `<condition attribute="ave_bizsafeapplicationenterprisestatuscode" operator="not-in">` +
    `<value>900000000</value><value>900000008</value><value>900000009</value><value>900000010</value><value>900000011</value>` +
    `</condition>` +
    `<condition attribute="ave_bizsafeapplicationenterprisestatuscode" operator="not-null"/>` +
    like +
    `</filter>` +
    `<order attribute="ave_bizsafeappcompanyguidname" descending="false"/>` +
    `<order attribute="ave_bizsafeappapplicationcategorycode" descending="false"/>` +
    `</entity></fetch>`;
}

// Formatted (display) value of a logical attribute; falls back to the raw value.
function fv(row, attr) {
  const keys = [`${attr}@OData.Community.Display.V1.FormattedValue`, `_${attr}_value@OData.Community.Display.V1.FormattedValue`, attr, `_${attr}_value`];
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return String(row[k]);
  }
  return '';
}

function rowName(row) {
  return fv(row, 'ave_bizsafeappcompanyguid') || fv(row, 'ave_bizsafeappcompanyguidname');
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

async function getPage(url) {
  return fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Let the last keep-alive socket close before the caller exits: on this Windows Node build an immediate
  // process.exit right after a fetch aborts with a libuv assertion (exit 127) even though the answer was printed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function run(keyword) {
  try {
    const started = Date.now();
    const text = searchText(keyword);
    const key = nameKey(keyword);
    if (!key) return fail('other', PAGE_URL, 'no company name left after removing the legal form');

    const count = 200;
    const rows = [];
    let firstUrl = '';
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${API}?fetchXml=${encodeURIComponent(buildFetch(page, count, text))}`;
      if (!firstUrl) firstUrl = url;
      let res;
      try {
        res = await getPage(url);
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return fail(timedOut ? 'timeout' : 'other', url, err?.message || err);
      }
      const body = await res.text();
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return fail('blocked', url, `HTTP ${res.status} ${body}`);
      }
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status} ${body}`);

      let json;
      try { json = JSON.parse(body); } catch { return fail('layout_changed', url, body); }
      if (!json || !Array.isArray(json.value)) return fail('layout_changed', url, body);

      total = json['@Microsoft.Dynamics.CRM.totalrecordcount'] ?? total;
      rows.push(...json.value);
      const more = json['@Microsoft.Dynamics.CRM.morerecords'] === true;
      if (!more) break;
      if (Date.now() - started > DEADLINE_MS) return fail('timeout', url, 'more pages than time allowed');
    }

    const matches = rows.filter((row) => nameKey(rowName(row)) === key);
    const sourceUrl = firstUrl;
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `Site answered; ${rows.length} entries for "${text}", none named like "${keyword}" (total ${total ?? 'n/a'})`,
      };
    }

    const records = matches.map((row) => ({
      name: rowName(row),
      bizsafe_level: fv(row, 'ave_bizsafeapplevelcode'),
      application_category: fv(row, 'ave_bizsafeappapplicationcategorycode'),
      bizsafe_status: fv(row, 'ave_bizsafeapplicationenterprisestatuscode'),
      submission_date: fv(row, 'ave_bizsafeappsubmissiondate'),
      approval_date: fv(row, 'ave_bizsafeappapprovaldate'),
      expiry_date: fv(row, 'ave_bizsafeappexpirydate'),
      returned_on: fv(row, 'ave_bizsafeappreturnedondate'),
      withdrawn_date: fv(row, 'ave_bizsafeappwithdrawndate'),
      revocation_end_date: fv(row, 'ave_bizsafeappsuspensionenddate'),
      termination_end_date: fv(row, 'ave_bizsafeappterminationenddate'),
    }));

    return {
      status: 'found', reason: '', records, source_url: sourceUrl,
      excerpt: records.map((r) => `${r.name} | ${r.bizsafe_level} | ${r.bizsafe_status} | expiry ${r.expiry_date}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    return fail('other', PAGE_URL, err?.message || err);
  }
}
