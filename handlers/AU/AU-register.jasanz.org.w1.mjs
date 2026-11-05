export const meta = {
  task: 'AU-register.jasanz.org',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['certificate_holder', 'standard', 'certifying_body', 'certificate_number', 'status', 'expiry_date'],
  canary: { found: 'SPF Diana Australia Pty. Ltd.', not_found: 'Pitcher Partners' },
};

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const url = 'https://jasanzcupr-api.azurewebsites.net/api/V1/RegisterCertificate/GetAllFilterCertificate';
    const body = {
      PageIndex: 0,
      PageSize: 10,
      schemeOwnerId: null,
      organisationName: keyword,
      tradingName: null,
      certification: null,
      city: null,
      cab: null,
      certScope: null,
      certStatus: null,
      country: [],
      certificationStandards: [],
      cabs: [],
      programs: [],
      isicCodes: [],
      schemes: [],
      certificateNumbers: []
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const json = await res.json();
    if (json && (!json.isSuccessful || !json.data) && (json.messageDetail?.message_shortcode === 'JASANZ_RECORDS_NOT_FOUND' || json.messageDetail?.message === 'Record not found.')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://register.jasanz.org/certified-organisations',
        excerpt: `Record not found for ${keyword}`
      };
    }

    if (!json || typeof json !== 'object' || !json.data || !Array.isArray(json.data.certificateDtos)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: JSON.stringify(json).slice(0, 200) };
    }

    const dtos = json.data.certificateDtos;
    const kwNorm = normalize(keyword);

    const matched = dtos.filter(item => {
      const orgNorm = normalize(item.organisationName);
      return orgNorm === kwNorm || orgNorm.includes(kwNorm) || kwNorm.includes(orgNorm);
    });

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://register.jasanz.org/certified-organisations',
        excerpt: `Found 0 matching certificates for ${keyword} (total raw count: ${json.data.count || 0})`
      };
    }

    const records = matched.map(m => {
      const scopeNames = Array.isArray(m.scopes) ? m.scopes.map(s => s.scopeName).join(', ') : '';
      return {
        certificate_holder: m.organisationName?.trim(),
        standard: scopeNames || 'Management System',
        certifying_body: m.cabName,
        certificate_number: m.certificateName,
        status: m.statusName,
        expiry_date: m.expriryDate
      };
    });

    const topCert = matched[0];
    const sourceUrl = topCert.certificateId 
      ? `https://register.jasanz.org/certified-organisations?id=${topCert.certificateId}`
      : 'https://register.jasanz.org/certified-organisations';

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: JSON.stringify(records[0]).slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://register.jasanz.org/certified-organisations',
      excerpt: String(err?.message || err)
    };
  }
}