export const meta = {
  task: 'SG-eservices.mlaw.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['company_name', 'uen', 'notice_type', 'publication_no', 'publication_date', 'notice_id'],
  canary: {
    found: 'PROPFIRM CAPITAL PTE. LTD.',
    not_found: 'Space Factor'
  }
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = (keyword || '').trim().toLowerCase();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://eservices.mlaw.gov.sg/ipto/forms/io/enotices/',
        excerpt: ''
      };
    }

    const payload = {
      TX_COMPANY_UEN: "",
      TX_COMPANY_NAME: "",
      ID_FIlter_Handler: 0,
      DT_PUBLICATION_START: null,
      DT_PUBLICATION_END: null,
      AM_Page_Number: 1,
      AM_Page_Size: 100
    };

    const apiUrl = 'https://eservices.mlaw.gov.sg/ACTIVANTS_CIMS_INT_API/api/GetNotices';
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(payload)
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

    if (!data || !Array.isArray(data.sIPNoticesField)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: JSON.stringify(data).slice(0, 300)
      };
    }

    const matchedRecords = [];
    let matchedSnippet = '';

    for (const item of data.sIPNoticesField) {
      const noticeName = item.tX_NOTICE_NAMEField || '';
      const noticeId = item.iD_FILE_GUID_NOTICEField || '';
      let entries = [];
      try {
        if (typeof item.tX_CONTENTField === 'string') {
          entries = JSON.parse(item.tX_CONTENTField);
        } else if (Array.isArray(item.tX_CONTENTField)) {
          entries = item.tX_CONTENTField;
        }
      } catch (err) {
        continue;
      }

      for (const entry of entries) {
        const compName = (entry.companyName || '').trim();
        const uen = (entry.uen || '').trim();

        if (compName.toLowerCase().includes(cleanKeyword) || cleanKeyword.includes(compName.toLowerCase())) {
          matchedRecords.push({
            company_name: compName,
            uen: uen,
            notice_type: noticeName,
            publication_no: entry.publicationNo || '',
            publication_date: entry.publicationDate || '',
            notice_id: noticeId
          });
          if (!matchedSnippet) {
            matchedSnippet = `${noticeName} - ${compName} (${uen})`;
          }
        }
      }
    }

    if (matchedRecords.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matchedRecords,
        source_url: 'https://eservices.mlaw.gov.sg/ipto/forms/io/enotices/',
        excerpt: matchedSnippet.slice(0, 500)
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: 'https://eservices.mlaw.gov.sg/ipto/forms/io/enotices/',
      excerpt: `Checked ${data.totalCountField || data.sIPNoticesField.length} notices`
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://eservices.mlaw.gov.sg/ipto/forms/io/enotices/',
      excerpt: err.message || String(err)
    };
  }
}
