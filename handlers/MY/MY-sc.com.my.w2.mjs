export const meta = {
  task: 'MY-sc.com.my',
  want: 'w2',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'licence_no', 'registration_no', 'licence_type', 'status', 'regulated_activities'],
  canary: {
    found: 'Maybank Asset Management Sdn Bhd',
    not_found: 'O2O Digital',
  },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = keyword.trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://investmentcheckerapi.sc.com.my/Entity',
        excerpt: 'Empty search keyword',
      };
    }

    const apiUrl = `https://investmentcheckerapi.sc.com.my/Entity?_name=${encodeURIComponent(cleanKeyword)}`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: apiUrl,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
      if (typeof data === 'string') data = JSON.parse(data);
    } catch {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: 'Response was not valid JSON',
      };
    }

    if (!data || !data.responseData) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: 'JSON response missing responseData property',
      };
    }

    const items = Array.isArray(data.responseData.data) ? data.responseData.data : [];
    const records = [];

    for (const item of items) {
      if (item && item.entityName) {
        records.push({
          name: item.entityName,
          licence_no: item.licenceNo || '',
          registration_no: item.registrationNo || '',
          licence_type: item.licenceTypeDesc || '',
          status: item.licenceStatusDesc || '',
          regulated_activities: item.regulatedAndRestrictedDesc || '',
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: apiUrl,
        excerpt: 'No licensed entities or registered persons found matching keyword.',
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: apiUrl,
      excerpt: `Found ${records.length} licensed entity/entities: ${records[0].name} (${records[0].licence_no})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://investmentcheckerapi.sc.com.my/Entity',
      excerpt: err.message || String(err),
    };
  }
}
