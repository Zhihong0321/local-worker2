export const meta = {
  task: 'SG-hdb.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'reg_no', 'casetrust', 'address', 'phone', 'email'],
  canary: { found: 'Space Factor', not_found: 'RSM Singapore' }
};

export default async function lookup(keyword) {
  const source_url = 'https://services2.hdb.gov.sg/webapp/BN31AWERRCMobile/BN31PListingContractor.jsp';
  const cookieJar = new Map();

  function updateCookies(res) {
    let setCookies = [];
    if (res.headers.getSetCookie) {
      setCookies = res.headers.getSetCookie();
    } else {
      const raw = res.headers.get('set-cookie');
      if (raw) setCookies = [raw];
    }
    for (const sc of setCookies) {
      const parts = sc.split(';');
      const [name, val] = parts[0].split('=');
      if (name && val !== undefined) {
        cookieJar.set(name.trim(), val.trim());
      }
    }
  }

  function getCookieHeader() {
    const parts = [];
    for (const [k, v] of cookieJar.entries()) {
      parts.push(`${k}=${v}`);
    }
    return parts.join('; ');
  }

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  try {
    const term = (keyword || '').trim();
    if (!term) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: ''
      };
    }

    // 1. Handshake to resolve redirect loop and acquire session cookies
    let currentUrl = source_url;
    let initialHtml = '';
    let userToken = '';

    for (let hop = 0; hop < 10; hop++) {
      const reqHeaders = { ...baseHeaders };
      const ch = getCookieHeader();
      if (ch) reqHeaders['Cookie'] = ch;

      const hopRes = await fetch(currentUrl, {
        headers: reqHeaders,
        redirect: 'manual'
      });
      updateCookies(hopRes);

      const loc = hopRes.headers.get('location');
      if (!loc) {
        initialHtml = await hopRes.text();
        const tokenMatch = initialHtml.match(/name="UserPreventionSessionToken"\s+value="([^"]+)"/i);
        if (tokenMatch) userToken = tokenMatch[1];
        break;
      }
      currentUrl = new URL(loc, currentUrl).href;
    }

    // Layout check on initial landing page
    if (!initialHtml.includes('Directory of Renovation Contractors') && !initialHtml.includes('BN31')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: 'Expected DRC header or form markers not found on landing page'
      };
    }

    // 2. Query retrieveCompanyNames autocomplete endpoint
    const searchKey = term.slice(0, 20);
    const retrieveUrl = 'https://services2.hdb.gov.sg/webapp/BN31AWERRCMobile/BN31SListingContractor?loadAction=retrieveCompanyNames';
    const postBody = new URLSearchParams({
      searchKey,
      selectOption: 'company'
    });

    const retRes = await fetch(retrieveUrl, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cookie': getCookieHeader(),
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': source_url
      },
      body: postBody.toString()
    });

    if (!retRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url,
        excerpt: `HTTP status ${retRes.status} from retrieveCompanyNames`
      };
    }

    const retText = await retRes.text();
    const parts = retText.split('|||');
    const returnCode = parts[0] ? parts[0].trim() : '';

    if (returnCode === '0002') {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: ''
      };
    }

    if (returnCode !== '0000') {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: `Unexpected return code ${returnCode}: ${retText.slice(0, 200)}`
      };
    }

    // Return code 0000 -> Parse options
    const optionsRaw = parts[2] || '';
    const rawList = optionsRaw.split('||').map(item => item.trim()).filter(Boolean);
    const companies = [];

    for (const item of rawList) {
      const [regNo, name] = item.split('~');
      if (regNo && regNo !== 'Pls' && name) {
        companies.push({ regNo: regNo.trim(), name: name.trim() });
      }
    }

    if (companies.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: ''
      };
    }

    // Find closest company match
    const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = clean(term);
    const targetWords = target.split(' ').filter(w => !['pte', 'ltd', 'sg', 'singapore'].includes(w) && w.length > 2);

    let matchedCompany = companies.find(c => clean(c.name).includes(target));
    if (!matchedCompany && targetWords.length > 0) {
      matchedCompany = companies.find(c => {
        const cName = clean(c.name);
        return targetWords.every(w => cName.includes(w));
      });
    }

    if (!matchedCompany) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: ''
      };
    }

    // 3. Post searchForm to retrieve detailed contractor record
    const formParams = new URLSearchParams({
      UserPreventionSessionToken: userToken,
      searchByValue: 'company',
      searchContValue: searchKey,
      selCompanyName: `${matchedCompany.regNo};${matchedCompany.name.replace(/ /g, '\u00A0')}`,
      searchTxt: '0'
    });

    const searchRes = await fetch('https://services2.hdb.gov.sg/webapp/BN31AWERRCMobile/BN31SSearchContractor?searchAction=searchContractor', {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookieHeader(),
        'Referer': source_url
      },
      body: formParams.toString()
    });

    if (searchRes.ok) {
      const searchHtml = await searchRes.text();
      const tableMatch = searchHtml.match(/<table\s+id="Record"[\s\S]*?<\/table>/i);
      if (tableMatch) {
        const rowMatch = tableMatch[0].match(/<tr>[\s\S]*?<td><a[^>]*data-regno="([^"]+)"[^>]*data-casetrust="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td>([\s\S]*?)<\/td>[\s\S]*?<td>([\s\S]*?)<\/td>[\s\S]*?<td>([\s\S]*?)<\/td>[\s\S]*?<td>([\s\S]*?)<\/td>/i);
        if (rowMatch) {
          const regNo = rowMatch[1].trim();
          const casetrust = rowMatch[2].trim();
          const name = rowMatch[3].replace(/<[^>]+>/g, '').trim();
          const address = rowMatch[5].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          const phone = rowMatch[6].replace(/<[^>]+>/g, '').trim();
          const email = rowMatch[7].replace(/<[^>]+>/g, '').trim();

          return {
            status: 'found',
            reason: '',
            records: [{
              name,
              reg_no: regNo,
              casetrust,
              address,
              phone,
              email
            }],
            source_url,
            excerpt: tableMatch[0].slice(0, 500)
          };
        }
      }
    }

    // Fallback if table was not returned
    return {
      status: 'found',
      reason: '',
      records: [{
        name: matchedCompany.name,
        reg_no: matchedCompany.regNo,
        casetrust: '',
        address: '',
        phone: '',
        email: ''
      }],
      source_url,
      excerpt: `${matchedCompany.regNo}~${matchedCompany.name}`
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: err.message
    };
  }
}
