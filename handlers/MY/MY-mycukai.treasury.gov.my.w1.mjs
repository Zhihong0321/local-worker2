import https from 'node:https';

export const meta = {
  task: 'MY-mycukai.treasury.gov.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'tax agent name',
  fields: ['name', 'approval_no', 'expiry_date', 'details'],
  canary: {
    found: 'DAVID TAN HONG EANG',
    not_found: 'YYC Advisors',
  },
};

function httpsRequest(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      rejectUnauthorized: false,
    };

    const req = https.request(reqOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsRequest(res.headers.location, options, postData));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: () => Promise.resolve(data),
      }));
    });

    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/** Look one tax agent or practitioner name up on MyCukai LHDNM Public Search. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return {
      status: 'couldnt_check',
      reason: 'invalid_input',
      records: [],
      source_url: 'https://mycukai.treasury.gov.my/portal/carian-lhdn-public',
      excerpt: '',
    };
  }

  const cleanKeyword = keyword.trim();
  const searchPageUrl = 'https://mycukai.treasury.gov.my/portal/carian-lhdn-public';

  try {
    // Step 1: GET search page to extract cookies, form action URL and formDate
    const getRes = await httpsRequest(searchPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (getRes.status !== 200) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchPageUrl,
        excerpt: `GET HTTP ${getRes.status}`,
      };
    }

    const html = await getRes.text();

    // Check layout marker
    const formActionMatch = html.match(/<form[^>]+action="([^"]+)"[^>]+name="_MyCukai_LHDNPublic_WAR_MyCukai_LHDNPublicportlet_fm_carian"/i);
    if (!formActionMatch) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchPageUrl,
        excerpt: 'Search form action not found in page',
      };
    }

    const actionUrl = formActionMatch[1].replace(/&amp;/g, '&');
    const cookies = getRes.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';

    const formDateMatch = html.match(/name="_MyCukai_LHDNPublic_WAR_MyCukai_LHDNPublicportlet_formDate"[^>]+value="([^"]+)"/i);
    const formDate = formDateMatch ? formDateMatch[1] : Date.now().toString();

    // Step 2: POST search query
    const postBody = [
      `_MyCukai_LHDNPublic_WAR_MyCukai_LHDNPublicportlet_formDate=${formDate}`,
      `_MyCukai_LHDNPublic_WAR_MyCukai_LHDNPublicportlet_id_negeri=`,
      `_MyCukai_LHDNPublic_WAR_MyCukai_LHDNPublicportlet_abjad_nama=`,
      `_MyCukai_LHDNPublic_WAR_MyCukai_LHDNPublicportlet_nama_penuh=${encodeURIComponent(cleanKeyword)}`,
    ].join('&');

    const postRes = await httpsRequest(actionUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'Cookie': cookies,
      },
    }, postBody);

    if (postRes.status !== 200) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: actionUrl,
        excerpt: `POST HTTP ${postRes.status}`,
      };
    }

    const postHtml = await postRes.text();

    // Check layout markers
    const hasNotFoundMarker = postHtml.includes('Tiada maklumat untuk dipaparkan');
    const hasTableMarker = postHtml.includes('Maklumat Ejen Cukai');

    if (!hasNotFoundMarker && !hasTableMarker) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: actionUrl,
        excerpt: 'Expected result table markers missing',
      };
    }

    if (hasNotFoundMarker) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: actionUrl,
        excerpt: 'Tiada maklumat untuk dipaparkan',
      };
    }

    // Parse result table rows
    const records = [];
    let excerpt = '';
    const rows = [...postHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

    for (const r of rows) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
      if (cells.length >= 4) {
        const agentInfo = cells[1];
        const approvalNo = cells[2];
        const expiryDate = cells[3];
        if (agentInfo && approvalNo) {
          records.push({
            name: agentInfo,
            approval_no: approvalNo,
            expiry_date: expiryDate,
            details: `Approval No: ${approvalNo}, Expiry: ${expiryDate}`,
          });
          if (!excerpt) {
            excerpt = `${agentInfo} | Approval: ${approvalNo} | Expiry: ${expiryDate}`;
          }
        }
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: actionUrl,
        excerpt: excerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: actionUrl,
      excerpt: 'No matching records in table',
    };
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: searchPageUrl,
      excerpt: e.message || 'Lookup failed',
    };
  }
}
