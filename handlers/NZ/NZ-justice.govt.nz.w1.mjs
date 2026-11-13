export const meta = { task: 'NZ-justice.govt.nz', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'permit_number', 'case_number', 'status', 'permit_end_date', 'application_type', 'town_city', 'trading_name', 'licence_classes'],
  canary: { found: 'TechShred Limited', not_found: 'Kōtuku Whakamarumaru Tōpū Limited' } };

// The Solr index behind the public PSPLA register (https://forms.justice.govt.nz/search/PSPLA/).
// The search page calls this same endpoint from the browser; it needs no login.
const SOLR_URL = 'https://forms.justice.govt.nz/forms/publicSolrProxy/solr/PSPLA/select';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co', 'llc', 'lp', 'plc']);
const MAX_ROWS = 100;
// Class flags the register shows per record; a value of "Granted" means the class is held.
const CLASS_FIELDS = {
  crowdController_s: 'crowd controller',
  documentDestructionAgent_s: 'document destruction agent',
  personalGuard_s: 'personal guard',
  privateInvestigator_s: 'private investigator',
  propertyGuard_s: 'property guard',
  repossessionAgent_s: 'repossession agent',
  securityConsultant_s: 'security consultant',
  securityTechnician_s: 'security technician',
  monitoringOfficer_s: 'monitoring officer',
};
const RECORD_FIELDS = ['id', 'name_txt', 'permitNumber_txt', 'caseNumber_txt', 'permitStatus_s', 'permitEndDate_s',
  'applicationType_s', 'townCity_txt', 'tradingName_txt', ...Object.keys(CLASS_FIELDS)];

const first = (v) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const allOf = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

/** Lower-case ASCII words, accents removed, punctuation dropped. */
function words(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Comparison key: normalised words with trailing legal-form words removed ("Acme Ltd" = "ACME LIMITED" = "acme"). */
function nameKey(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL_FORMS.has(w[w.length - 1])) w.pop();
  return w.join('');
}

/** The phrase sent to Solr: the typed name with any trailing legal form removed. */
function searchPhrase(keyword) {
  const w = String(keyword).trim().split(/\s+/).filter(Boolean);
  while (w.length > 1 && LEGAL_FORMS.has(words(w[w.length - 1]).join(''))) w.pop();
  return w.join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword ?? '').trim();
    const phrase = searchPhrase(kw);
    if (!phrase || !nameKey(kw)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOLR_URL, excerpt: 'empty company name' };
    }

    const url = new URL(SOLR_URL);
    const escaped = phrase.replace(/[\\"]/g, '\\$&');
    url.searchParams.set('q', `name_txt:"${escaped}"`);
    url.searchParams.append('fq', 'jurisdictionCode_s:PSPLA');
    url.searchParams.append('fq', 'permitHasBeenIssued_b:true');
    url.searchParams.set('fl', RECORD_FIELDS.join(','));
    url.searchParams.set('rows', String(MAX_ROWS));
    url.searchParams.set('start', '0');
    url.searchParams.set('wt', 'json');
    const sourceUrl = url.href;

    const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) });

    let res;
    try {
      res = await fetch(sourceUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return fail(timedOut ? 'timeout' : 'other', e?.message || e);
    }

    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|access denied/i.test(text.slice(0, 2000))) return fail('blocked', text.slice(0, 300));

    let data;
    try { data = JSON.parse(text); } catch { return fail('layout_changed', text.slice(0, 300)); }

    const body = data?.response;
    if (!body || !Array.isArray(body.docs) || typeof body.numFound !== 'number') {
      return fail('layout_changed', JSON.stringify(data).slice(0, 300));
    }
    if (data.responseHeader && data.responseHeader.status !== 0) {
      return fail('other', `Solr status ${data.responseHeader.status}`);
    }

    const want = nameKey(kw);
    const records = [];
    for (const d of body.docs) {
      const names = allOf(d.name_txt);
      if (!names.some((n) => nameKey(n) === want)) continue;
      const classes = Object.entries(CLASS_FIELDS)
        .filter(([f]) => String(first(d[f])).toLowerCase() === 'granted')
        .map(([, label]) => label);
      records.push({
        name: first(d.name_txt),
        permit_number: first(d.permitNumber_txt),
        case_number: first(d.caseNumber_txt),
        status: first(d.permitStatus_s),
        permit_end_date: first(d.permitEndDate_s),
        application_type: first(d.applicationType_s),
        town_city: first(d.townCity_txt),
        trading_name: first(d.tradingName_txt),
        licence_classes: classes,
      });
    }

    if (records.length === 0) {
      if (body.numFound > body.docs.length) {
        // More hits than we read: a match could be past the first page, so do not claim "not listed".
        return fail('other', `${body.numFound} register hits for "${phrase}", only the first ${body.docs.length} were read`);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `0 PSPLA register records match "${kw}" (${body.numFound} hits for "${phrase}", none with the same name)`,
      };
    }

    return {
      status: 'found', reason: '', records, source_url: sourceUrl,
      excerpt: records.map((r) => `${r.name}; licence ${r.permit_number}; ${r.status}; ends ${r.permit_end_date}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOLR_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
