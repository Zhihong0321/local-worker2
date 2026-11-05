export const meta = {
  task: 'SG-mas.gov.sg',
  want: 'w2',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['unregulated_person', 'website', 'address', 'phone', 'date_added', 'alert_url'],
  canary: {
    found: 'Handsworth Advisory Pte Ltd',
    not_found: 'Space Factor'
  }
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = (keyword || '').trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://www.mas.gov.sg/investor-alert-list',
        excerpt: ''
      };
    }

    const apiUrl = `https://www.mas.gov.sg/api/v1/ialsearch?json.nl=map&wt=json&q=${encodeURIComponent('"' + cleanKeyword + '"')}&rows=10&start=0`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: apiUrl,
        excerpt: `HTTP ${res.status} ${res.statusText}`
      };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: 'Failed to parse JSON response'
      };
    }

    if (!data || !data.response || !Array.isArray(data.response.docs)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: JSON.stringify(data).slice(0, 300)
      };
    }

    const docs = data.response.docs;
    const normKw = cleanKeyword.toLowerCase().replace(/[^a-z0-9]/g, '');

    const matched = [];
    for (const doc of docs) {
      const name = doc.unregulatedpersons_s || (doc.unregulatedpersons_t ? doc.unregulatedpersons_t.join('; ') : '');
      const website = doc.website_s || '';
      const address = (doc.address_s || '').replace(/\s+/g, ' ').trim();
      const phone = (doc.phonenumber_s || '').replace(/\s+/g, ' ').trim();
      const date = doc.date_s || doc.approveddate_s || doc.modifieddate_s || '';
      const url = doc.url || `https://www.mas.gov.sg/investor-alert-list?q=${encodeURIComponent(cleanKeyword)}`;

      const normName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normWeb = website.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (normName.includes(normKw) || normKw.includes(normName) || (normKw.length > 5 && normWeb.includes(normKw))) {
        matched.push({
          unregulated_person: name,
          website,
          address,
          phone,
          date_added: date,
          alert_url: url
        });
      }
    }

    if (matched.length > 0) {
      const excerpt = `${matched[0].unregulated_person} (Added: ${matched[0].date_added}) - ${matched[0].website}`;
      return {
        status: 'found',
        reason: '',
        records: matched,
        source_url: `https://www.mas.gov.sg/investor-alert-list?q=${encodeURIComponent(cleanKeyword)}`,
        excerpt: excerpt.slice(0, 500)
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `https://www.mas.gov.sg/investor-alert-list?q=${encodeURIComponent(cleanKeyword)}`,
      excerpt: `No investor alert matching ${cleanKeyword}`
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.mas.gov.sg/investor-alert-list',
      excerpt: err.message || String(err)
    };
  }
}
