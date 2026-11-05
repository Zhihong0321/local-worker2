export const meta = {
  task: 'SG-data.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name or UEN',
  fields: ['name', 'uen', 'status', 'type', 'issue_date', 'address'],
  canary: {
    found: 'SPACE FACTOR PTE. LTD.',
    not_found: 'RSM Singapore'
  }
};

export default async function lookup(keyword) {
  const normKey = String(keyword).trim().toUpperCase();
  const cleanKey = normKey.replace(/[^A-Z0-9]/g, '');
  if (!cleanKey) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: 'https://data.gov.sg/',
      excerpt: ''
    };
  }

  const isUen = cleanKey.length >= 9 && cleanKey.length <= 10 && /\d/.test(cleanKey);
  const filterObj = isUen ? { uen: cleanKey } : { entity_name: normKey };
  const filterUrl = `https://data.gov.sg/api/action/datastore_search?resource_id=d_3f960c10fed6145404ca7b821f263b87&filters=${encodeURIComponent(JSON.stringify(filterObj))}&limit=10`;

  try {
    const res = await fetch(filterUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: filterUrl,
        excerpt: `HTTP ${res.status}`
      };
    }

    const data = await res.json();
    if (!data || typeof data !== 'object' || !data.result) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: filterUrl,
        excerpt: JSON.stringify(data).slice(0, 500)
      };
    }

    if (Array.isArray(data.result.records) && data.result.records.length > 0) {
      const records = data.result.records.map(r => ({
        name: r.entity_name || '',
        uen: r.uen || '',
        status: r.uen_status_desc || '',
        type: r.entity_type_desc || '',
        issue_date: r.uen_issue_date || '',
        address: `${r.reg_street_name || ''} ${r.reg_postal_code || ''}`.trim()
      }));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: filterUrl,
        excerpt: JSON.stringify(records[0]).slice(0, 500)
      };
    }

    const qUrl = `https://data.gov.sg/api/action/datastore_search?resource_id=d_3f960c10fed6145404ca7b821f263b87&q=${encodeURIComponent(keyword)}&limit=100`;
    const resQ = await fetch(qUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!resQ.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: qUrl,
        excerpt: `HTTP ${resQ.status}`
      };
    }

    const dataQ = await resQ.json();
    if (!dataQ || !dataQ.result || !Array.isArray(dataQ.result.records)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: qUrl,
        excerpt: JSON.stringify(dataQ).slice(0, 500)
      };
    }

    const matched = dataQ.result.records.filter(r => {
      const cleanName = (r.entity_name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const cleanUen = (r.uen || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return cleanName.includes(cleanKey) || cleanUen === cleanKey;
    });

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: qUrl,
        excerpt: ''
      };
    }

    const records = matched.map(r => ({
      name: r.entity_name || '',
      uen: r.uen || '',
      status: r.uen_status_desc || '',
      type: r.entity_type_desc || '',
      issue_date: r.uen_issue_date || '',
      address: `${r.reg_street_name || ''} ${r.reg_postal_code || ''}`.trim()
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: qUrl,
      excerpt: JSON.stringify(records[0]).slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://data.gov.sg/',
      excerpt: String(err).slice(0, 500)
    };
  }
}
