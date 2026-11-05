export const meta = {
  task: 'SG-bizsafe.wshc.sg',
  want: 'w2',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'level', 'expiry_date'],
  canary: {
    found: 'Space Factor',
    not_found: 'RSM Singapore'
  }
};

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default async function lookup(keyword) {
  try {
    const escaped = escapeXml(keyword);
    const fetchXml = `
<fetch returntotalrecordcount="true" count="10" page="1" distinct="true">
  <entity name="incident">
    <order attribute="ave_bizsafeappcompanyguid" descending="false" />
    <attribute name="incidentid" />
    <attribute name="ave_bizsafeappcompanyguid"/>
    <attribute name="ave_bizsafeapplevelcode"/>
    <attribute name="ave_bizsafeappexpirydate"/>
    <attribute name="ave_bizsafeappapplicationcategorycode"/>
    <filter type="and">
      <condition attribute="ave_bizsafepplicationstatuscode" operator="eq" value="900000001"/>
      <condition attribute="ave_bizsafeapplicationenterprisestatuscode" operator="eq" value="900000003"/>
      <condition attribute="ave_bizsafeappapplicationcategorycode" operator="eq" value="900000000"/>
      <condition attribute="ave_bizsafeappcompanyguidname" operator="like" value="%${escaped}%"/>
    </filter>
  </entity>
</fetch>`.replace(/\s{2,}|\n/g, ' ').trim();

    const url = `https://bizsafe.wshc.sg/_api/incidents?fetchXml=${encodeURIComponent(fetchXml)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-requested-with': 'XMLHttpRequest'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: url,
        excerpt: `HTTP ${res.status}`
      };
    }

    const json = await res.json();
    if (!json || !Array.isArray(json.value)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: JSON.stringify(json).slice(0, 500)
      };
    }

    if (json.value.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: ''
      };
    }

    const records = json.value.map(item => ({
      name: item['_ave_bizsafeappcompanyguid_value@OData.Community.Display.V1.FormattedValue'] || '',
      level: item['ave_bizsafeapplevelcode@OData.Community.Display.V1.FormattedValue'] || '',
      expiry_date: item['ave_bizsafeappexpirydate@OData.Community.Display.V1.FormattedValue'] || ''
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: JSON.stringify(records[0]).slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://bizsafe.wshc.sg/marketplace',
      excerpt: String(err).slice(0, 500)
    };
  }
}
