export const meta = {
  task: 'SG-peb.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name or engineer name',
  fields: ['name', 'branch', 'type', 'ref_no', 'director', 'address'],
  canary: { found: 'AECOM Singapore Pte. Ltd.', not_found: 'Space Factor' },
};

const CORP_RESOURCE_ID = 'd_4659c002f4b00d44d01bfe1300064cb1';
const PE_RESOURCE_ID = 'd_f92927723e0894a14ee3acca6411e73d';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www1.peb.gov.sg/find-a-professional-engineer/directory-of-licensed-corporations-and-partnerships/',
      excerpt: 'Empty keyword provided'
    };
  }

  const cleanKeyword = keyword.trim();
  const normKw = cleanKeyword.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const coreKw = normKw.replace(/\b(PTE|LTD|LIMITED|PRIVATE|LLP|SINGAPORE)\b/g, '').trim();

  const sourceUrl = 'https://www1.peb.gov.sg/find-a-professional-engineer/directory-of-licensed-corporations-and-partnerships/';

  try {
    // 1. Check PEB Licensed Corporations (data.gov.sg resource backing the PEB Isomer portal)
    const corpUrl = `https://data.gov.sg/api/action/datastore_search?resource_id=${CORP_RESOURCE_ID}&limit=500`;
    const corpRes = await fetch(corpUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (corpRes.status === 403 || corpRes.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: sourceUrl,
        excerpt: `HTTP ${corpRes.status}`
      };
    }

    if (!corpRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: sourceUrl,
        excerpt: `HTTP ${corpRes.status} ${corpRes.statusText}`
      };
    }

    const corpData = await corpRes.json().catch(() => null);
    if (!corpData || typeof corpData.success !== 'boolean') {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: sourceUrl,
        excerpt: 'Response JSON missing expected success property'
      };
    }

    if (corpData.success && Array.isArray(corpData.result?.records)) {
      const records = corpData.result.records;
      const matched = records.filter(r => {
        if (!r.Company) return false;
        const normName = r.Company.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
        if (normName === normKw) return true;
        if (normName.includes(normKw)) return true;
        if (coreKw.length >= 3 && normName.includes(coreKw)) return true;
        return false;
      });

      if (matched.length > 0) {
        const mapped = matched.map(m => ({
          name: m.Company || '',
          branch: m.Branch || '',
          type: m.Type_of_Entity || '',
          ref_no: m.Reference_No || '',
          director: m.Supervising_Director || '',
          address: m.Company_Address || ''
        }));
        return {
          status: 'found',
          reason: '',
          records: mapped,
          source_url: sourceUrl,
          excerpt: JSON.stringify(mapped[0])
        };
      }
    }

    // 2. Check PE with PC register for employer or engineer match
    const filter = JSON.stringify({ Practice_EmployerName: cleanKeyword });
    const peUrl = `https://data.gov.sg/api/action/datastore_search?resource_id=${PE_RESOURCE_ID}&filters=${encodeURIComponent(filter)}&limit=10`;
    const peRes = await fetch(peUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (peRes.ok) {
      const peData = await peRes.json().catch(() => null);
      if (peData && peData.success && Array.isArray(peData.result?.records) && peData.result.records.length > 0) {
        const mapped = peData.result.records.map(r => ({
          name: r.Fullname || '',
          branch: r.Branch || '',
          type: r.Practice_EmployerType || 'Practising Engineer',
          ref_no: r.RegNo || '',
          director: r.Practice_EmployerName || '',
          address: r.Practice_EmployerAddress || ''
        }));
        return {
          status: 'found',
          reason: '',
          records: mapped,
          source_url: 'https://www1.peb.gov.sg/find-a-professional-engineer/directory-of-professional-engineers-with-practicing-certificate/',
          excerpt: JSON.stringify(mapped[0])
        };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `No matching licensed corporation or practicing engineer found for ${cleanKeyword}`
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'AbortError' ? 'timeout' : 'http_error',
      records: [],
      source_url: sourceUrl,
      excerpt: err.message || String(err)
    };
  }
}
