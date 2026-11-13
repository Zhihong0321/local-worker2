export const meta = {
  task: 'PH-bsp.gov.ph',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'short_name', 'institution_type', 'institution_type_code', 'address', 'authority', 'number_of_offices', 'contact', 'email', 'website', 'status', 'institution_id'],
  canary: { found: 'Security Bank Corporation', not_found: 'Kompanyang Walang Pangalan Inc.' },
};

// BSP "Directory of Banks and Non-Bank Financial Institutions" (SitePages/FinancialStability/DirBanksFIList.aspx)
// reads the SharePoint list "Institutions" through the site's anonymous REST API. This handler searches that list.
const SITE = 'https://www.bsp.gov.ph';
const LIST_URL = `${SITE}/_api/web/lists/getbytitle('Institutions')/items?$select=InstitutionID,Title,InstitutionTypeID3,Address,NumOffice,Authority,Contact,Status,Email,Website,ShortBankName&$top=5000&$orderby=Title`;
const TYPES_URL = `${SITE}/_api/web/lists/getbytitle('Financial%20Institution')/items?$select=Code,Title&$top=5000`;
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  accept: 'application/json;odata=verbose',
};
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc', 'sdn', 'bhd', 'the']);

/** Normalised comparison keys for a name: case, accents, punctuation and legal form removed. */
function nameKeys(str) {
  const core = (s) => String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w)).join('');
  const withoutParens = String(str || '').replace(/\([^)]*\)/g, ' ');
  return [...new Set([core(str), core(withoutParens)])].filter(Boolean);
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Fetch one list; returns the parsed rows, or a couldnt_check answer as { failed }. */
async function fetchRows(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (res.status === 403 || res.status === 429) return { failed: failure('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { failed: failure('http_error', url, `HTTP ${res.status}`) };
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { return { failed: failure('layout_changed', url, text.slice(0, 200)) }; }
  if (!body || !body.d || !Array.isArray(body.d.results)) return { failed: failure('layout_changed', url, text.slice(0, 200)) };
  if (body.d.__next) return { failed: failure('other', url, 'list has more than one page; not all entries could be read') };
  return { rows: body.d.results };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return failure('other', LIST_URL, 'empty company name');
    const keys = nameKeys(name);
    if (keys.length === 0) return failure('other', LIST_URL, 'company name has no letters or digits');

    const [inst, types] = await Promise.all([fetchRows(LIST_URL), fetchRows(TYPES_URL).catch(() => null)]);
    if (inst.failed) return inst.failed;
    const rows = inst.rows;
    if (rows.length === 0) return failure('layout_changed', LIST_URL, 'the Institutions list came back empty');

    // Type names are optional: without them the record still carries the type code.
    const typeMap = new Map(((types && types.rows) || []).map((t) => [String(t.Code), t.Title]));

    const matches = rows.filter((r) => {
      const titleKeys = nameKeys(r.Title);
      return keys.some((k) => titleKeys.includes(k));
    });

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No match for "${name}" in the BSP Institutions directory (${rows.length} entries). Scope: banks and non-bank financial institutions; the EMI, VASP and MSB lists are separate PDF/XLSX files and were not searched.`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((r) => ({
        name: r.Title,
        short_name: r.ShortBankName || '',
        institution_type: (typeMap.get(String(r.InstitutionTypeID3)) || '').trim(),
        institution_type_code: String(r.InstitutionTypeID3 ?? ''),
        address: r.Address || '',
        authority: r.Authority || '',
        number_of_offices: r.NumOffice || '',
        contact: r.Contact || '',
        email: r.Email || '',
        website: r.Website || '',
        status: r.Status || '',
        institution_id: r.InstitutionID || '',
      })),
      source_url: LIST_URL,
      excerpt: `Matched "${matches[0].Title}" in the BSP Institutions directory (${matches.length} match(es), ${rows.length} entries searched)`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(timedOut ? 'timeout' : 'other', LIST_URL, String(err?.message || err));
  }
}
