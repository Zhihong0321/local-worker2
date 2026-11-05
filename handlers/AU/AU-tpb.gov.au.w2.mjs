export const meta = {
  task: 'AU-tpb.gov.au',
  want: 'w2',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'status', 'registration_number', 'sanction_type', 'details'],
  canary: {
    found: 'XO Accounting Pty. Ltd.',
    not_found: 'Pitcher Partners'
  }
};

function norm(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(pty|ltd|limited|proprietary)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCompany(agentName, keyword) {
  if (!agentName || !keyword) return false;
  const aNorm = norm(agentName);
  const kNorm = norm(keyword);
  if (aNorm === kNorm || aNorm.includes(kNorm)) return true;

  const stopWords = new Set(['the', 'and', 'co']);
  const keyWords = kNorm.split(' ').filter(w => !stopWords.has(w) && w.length > 1);
  if (keyWords.length === 0) return aNorm.includes(kNorm);

  const aWords = new Set(aNorm.split(' '));
  return keyWords.every(w => aWords.has(w));
}

/** Look one company up for sanctions/orders. Must never throw. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = (keyword || '').trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: 'Empty search keyword'
      };
    }

    // 1. Fetch register page
    const pageRes = await fetch('https://myprofile.tpb.gov.au/public-register/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!pageRes.ok) {
      return {
        status: 'couldnt_check',
        reason: `http_error: ${pageRes.status}`,
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: `Failed to load register page: HTTP ${pageRes.status}`
      };
    }

    const cookieMap = new Map();
    const rawCookies = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [pageRes.headers.get('set-cookie')].filter(Boolean);
    for (const c of rawCookies) {
      const part = c.split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) cookieMap.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }

    const text = await pageRes.text();
    const layoutMatch = text.match(/data-view-layouts=['"]([^'"]+)['"]/);
    if (!layoutMatch) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: 'Missing data-view-layouts configuration'
      };
    }

    let base64Config;
    try {
      const layouts = JSON.parse(Buffer.from(layoutMatch[1], 'base64').toString('utf8'));
      base64Config = layouts[0]?.Base64SecureConfiguration;
    } catch {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: 'Failed to decode data-view-layouts JSON'
      };
    }

    const gridMatch = text.match(/data-get-url="\/_services\/entity-grid-data\.json\/([^"']+)"/);
    const gridId = gridMatch ? gridMatch[1] : 'd78574f9-20c3-4dcc-8d8d-85cf5b7ac141';
    const getCookieHeader = () => [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

    // 2. Fetch token
    const tokenRes = await fetch('https://myprofile.tpb.gov.au/_layout/tokenhtml', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': getCookieHeader(),
        'Referer': 'https://myprofile.tpb.gov.au/public-register/'
      }
    });

    const tokenCookies = tokenRes.headers.getSetCookie ? tokenRes.headers.getSetCookie() : [tokenRes.headers.get('set-cookie')].filter(Boolean);
    for (const c of tokenCookies) {
      const part = c.split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) cookieMap.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }

    const tokenText = await tokenRes.text();
    const tokenMatch = tokenText.match(/value="([^"']+)"/);
    const verificationToken = tokenMatch ? tokenMatch[1] : '';

    // 3. Post query
    const filterQuery = cleanKeyword.replace(/\s+/g, '*');
    const postUrl = `https://myprofile.tpb.gov.au/_services/entity-grid-data.json/${gridId}`;
    const payload = {
      base64SecureConfiguration: base64Config,
      sortExpression: 'datacom_agent ASC',
      search: null,
      page: 1,
      pageSize: 25,
      pagingCookie: null,
      filter: null,
      metaFilter: `0=${encodeURIComponent(filterQuery)}`,
      timezoneOffset: -600
    };

    const res = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': getCookieHeader(),
        'Referer': 'https://myprofile.tpb.gov.au/public-register/',
        'Origin': 'https://myprofile.tpb.gov.au',
        '__RequestVerificationToken': verificationToken
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: `http_error: ${res.status}`,
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: `Entity grid request failed with status ${res.status}`
      };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: 'Entity grid response was not valid JSON'
      };
    }

    if (!Array.isArray(data.Records)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: 'Entity grid response missing Records array'
      };
    }

    const matchingPractitioners = [];
    for (const rec of data.Records) {
      const getAttr = name => rec.Attributes?.find(a => a.Name === name)?.DisplayValue || '';
      const agentName = getAttr('datacom_agent');
      if (matchCompany(agentName, cleanKeyword)) {
        matchingPractitioners.push({
          name: agentName,
          status: getAttr('datacom_publicregisterstatus'),
          registration_number: getAttr('datacom_registrationnumber'),
          id: rec.Id
        });
      }
    }

    if (matchingPractitioners.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: `No matching practitioner found on TPB register for "${cleanKeyword}"`
      };
    }

    // 4. For matched practitioners, check for disciplinary notations / sanctions / publication decisions
    const sanctionsFound = [];

    for (const p of matchingPractitioners) {
      const ran = p.registration_number;
      const detailUrl = ran
        ? `https://myprofile.tpb.gov.au/public-register/practitioner/?ran=${encodeURIComponent(ran)}`
        : `https://myprofile.tpb.gov.au/public-register/practitioner/?id=${encodeURIComponent(p.id)}`;

      const statusLower = (p.status || '').toLowerCase();
      // Disciplinary indicators in status (exclude voluntary surrender)
      const isDisciplinaryStatus = statusLower.includes('sanction') ||
        statusLower.includes('publication decision') ||
        statusLower.includes('suspended');

      let detailHtml = '';
      try {
        const detailRes = await fetch(detailUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        if (detailRes.ok) {
          detailHtml = await detailRes.text();
        }
      } catch {}

      const sections = ['Suspensions', 'Sanctions', 'Publication Decisions', 'Disqualifications', 'Termination'];
      let detailsText = '';

      for (const sec of sections) {
        const secIdx = detailHtml.indexOf(`<b>${sec}</b>`);
        if (secIdx !== -1) {
          const slice = detailHtml.slice(secIdx, secIdx + 1500);
          if (!slice.includes('None on record')) {
            // Check if termination is voluntary surrender
            if (sec === 'Termination' && slice.toLowerCase().includes('surrender')) {
              continue; // Voluntary surrender is not a disciplinary order
            }
            const cleanText = slice.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            detailsText += `${sec}: ${cleanText.slice(0, 200)}; `;
          }
        }
      }

      if (isDisciplinaryStatus || detailsText) {
        sanctionsFound.push({
          name: p.name,
          status: p.status,
          registration_number: p.registration_number,
          sanction_type: isDisciplinaryStatus ? p.status : 'Board Order / Sanction',
          details: detailsText || p.status
        });
      }
    }

    if (sanctionsFound.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://myprofile.tpb.gov.au/public-register/',
        excerpt: `No disciplinary notations, orders, suspensions, or terminations recorded for "${cleanKeyword}"`
      };
    }

    const excerpt = `Found ${sanctionsFound.length} disciplinary notation(s)/sanction(s): ${sanctionsFound.map(s => `${s.name} (${s.sanction_type}, #${s.registration_number}) - ${s.details}`).join('; ')}`.slice(0, 500);

    return {
      status: 'found',
      reason: '',
      records: sanctionsFound,
      source_url: 'https://myprofile.tpb.gov.au/public-register/',
      excerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://myprofile.tpb.gov.au/public-register/',
      excerpt: `Lookup exception: ${err.message}`
    };
  }
}
