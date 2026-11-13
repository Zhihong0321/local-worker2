export const meta = { task: 'SG-charities.gov.sg', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'uen', 'type', 'charity_status', 'ipc_status', 'ipc_valid_from', 'ipc_valid_till', 'primary_sector',
    'primary_classification', 'sector_administrator', 'activities', 'registration_date', 'deregistration_date', 'profile_url'],
  canary: { found: 'SINGAPORE RED CROSS SOCIETY', not_found: 'Persatuan Kebajikan Tiada Wujud' } };

const SITE = 'https://www.charities.gov.sg';
const SEARCH_PAGE = `${SITE}/Pages/BasicSearch.aspx`;
const HANDLER = `${SITE}/_layouts/15/CPInternet/BasicSearchHandler.ashx`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['pte', 'ltd', 'limited', 'llp', 'sdn', 'bhd', 'inc', 'llc', 'plc', 'corp', 'corporation']);
const PAGE_LENGTH = 100;

/** Lower-case words; punctuation and & removed. Works for non-Latin letters too. */
function words(str) {
  return String(str || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Name without legal-form words, joined: "ACME TRADING PTE. LTD." -> "acmetrading". */
function normalize(str) {
  return words(str).filter((w) => !LEGAL_FORMS.has(w)).join('');
}

/** Name without legal-form words, spaced: used as a second search query. */
function withoutLegalForm(str) {
  return words(str).filter((w) => !LEGAL_FORMS.has(w)).join(' ');
}

function fail(status, reason, sourceUrl, excerpt) {
  return { status, reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 500) };
}

function toRecord(r) {
  return {
    name: r.CharityIPCName,
    uen: r.UENNo,
    type: r.Type,
    charity_status: r.CharityStatus,
    ipc_status: r.IPCStatus,
    ipc_valid_from: r.IPCValidFrom,
    ipc_valid_till: r.IPCValidTill,
    primary_sector: r.PrimarySector,
    primary_classification: r.PrimaryClassification,
    sector_administrator: r.SectorAdministrato,
    activities: r.Activities,
    registration_date: r.RegistrationDate,
    deregistration_date: r.DeRegistrationDate,
    profile_url: r.CharityAccountCRMRecordID
      ? `${SITE}/_layouts/15/CPInternet/SearchOrgProfile.aspx?q=${btoa(r.CharityAccountCRMRecordID)}`
      : null,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const typed = String(keyword || '').trim();
  const sourceUrl = `${SEARCH_PAGE}?q=${encodeURIComponent(typed)}`;
  try {
    const want = normalize(typed);
    if (!want) return fail('couldnt_check', 'other', sourceUrl, 'empty company name');

    // First the name as typed; then, if different, the name without legal-form words (the site returns 0 for "PTE LTD").
    const queries = [typed];
    const stripped = withoutLegalForm(typed);
    if (stripped && stripped !== typed) queries.push(stripped);

    const similar = [];
    for (const query of queries) {
      const body = new URLSearchParams({
        query, sortColumn: '', sortDirection: '', reqType: 'charityInfo', filterColumn: '',
        draw: '1', start: '0', length: String(PAGE_LENGTH),
      });
      const res = await fetch(HANDLER, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body,
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return fail('couldnt_check', 'blocked', sourceUrl, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return fail('couldnt_check', 'http_error', sourceUrl, `HTTP ${res.status}`);
      }

      const text = await res.text();
      if (/incapsula|incident_id|request unsuccessful|captcha/i.test(text)) {
        return fail('couldnt_check', 'blocked', sourceUrl, text.slice(0, 300));
      }

      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || !Array.isArray(data.charityInfosData) || typeof data.recordsFiltered !== 'number') {
        return fail('couldnt_check', 'layout_changed', sourceUrl, text.slice(0, 300));
      }

      const rows = data.charityInfosData;
      const truncated = data.recordsFiltered > rows.length;
      const matches = rows.filter((r) => normalize(r.CharityIPCName) === want);

      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches.map(toRecord),
          source_url: sourceUrl,
          excerpt: `${matches.length} exact match(es) on the site for "${typed}": ${matches.map((m) => m.CharityIPCName).join('; ')}`,
        };
      }
      if (truncated) {
        return fail('couldnt_check', 'other', sourceUrl,
          `${data.recordsFiltered} results for "${query}"; the exact name was not among the first ${rows.length}`);
      }
      for (const r of rows) similar.push(r.CharityIPCName);
    }

    const sample = [...new Set(similar)].slice(0, 5).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `0 exact matches for "${typed}" on the site` + (sample ? `. Similar names listed: ${sample}` : '. The search returned 0 results.'),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail('couldnt_check', timeout ? 'timeout' : 'other', sourceUrl, String(err?.message || err));
  }
}
