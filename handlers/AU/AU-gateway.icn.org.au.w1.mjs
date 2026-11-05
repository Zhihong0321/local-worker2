export const meta = {
  task: 'AU-gateway.icn.org.au',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'company_id', 'address', 'city', 'state', 'email'],
  canary: { found: 'Bastion Pacific Pty Ltd', not_found: 'Pitcher Partners' },
};

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    // Step 1: GET /suppliers to obtain session cookies and CSRF token
    const initialUrl = 'https://gateway.icn.org.au/suppliers';
    const initRes = await fetch(initialUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (initRes.status === 403 || initRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: initialUrl, excerpt: `HTTP ${initRes.status}` };
    }
    if (!initRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: initialUrl, excerpt: `HTTP ${initRes.status}` };
    }

    const initHtml = await initRes.text();
    const csrfMatch = initHtml.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!csrfMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: initialUrl, excerpt: initHtml.slice(0, 300) };
    }
    const csrfToken = csrfMatch[1];

    const cookies = initRes.headers.getSetCookie ? initRes.headers.getSetCookie() : [];
    const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

    // Step 2: POST /suppliers/search
    const fd = new FormData();
    fd.append('lat', '-25.274398');
    fd.append('lng', '133.775136');
    fd.append('ne_lat', '-10');
    fd.append('ne_lng', '155');
    fd.append('sw_lat', '-45');
    fd.append('sw_lng', '110');
    fd.append('location', '');
    fd.append('location_entry', '');
    fd.append('search_type', '1');
    fd.append('abn', '');
    fd.append('keywords', keyword);

    const searchUrl = 'https://gateway.icn.org.au/suppliers/search';
    const searchRes = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-CSRF-TOKEN': csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*',
        'Cookie': cookieHeader,
        'Referer': initialUrl
      },
      body: fd
    });

    if (searchRes.status === 403 || searchRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${searchRes.status}` };
    }
    if (!searchRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${searchRes.status}` };
    }

    const json = await searchRes.json();
    if (!json || typeof json !== 'object' || !Array.isArray(json.suppliers)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: JSON.stringify(json).slice(0, 200) };
    }

    const kwNorm = normalize(keyword);
    const matched = json.suppliers.filter(s => {
      const nameNorm = normalize(s.company_name);
      return nameNorm === kwNorm || nameNorm.includes(kwNorm) || kwNorm.includes(nameNorm);
    });

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: initialUrl,
        excerpt: `Found 0 matching suppliers for ${keyword} (total search candidates: ${json.suppliers.length})`
      };
    }

    const uniqueMap = new Map();
    for (const m of matched) {
      if (!uniqueMap.has(m.companyid)) {
        uniqueMap.set(m.companyid, {
          name: m.company_name,
          company_id: String(m.companyid),
          address: m.address || `${m.address_street_1 || ''} ${m.address_street_city || ''} ${m.address_street_state || ''}`.trim(),
          city: m.address_street_city,
          state: m.address_street_state,
          email: m.email
        });
      }
    }

    const records = Array.from(uniqueMap.values());
    const topId = records[0].company_id;

    return {
      status: 'found',
      reason: '',
      records,
      source_url: `https://gateway.icn.org.au/suppliers/${topId}`,
      excerpt: JSON.stringify(matched[0]).slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://gateway.icn.org.au/suppliers',
      excerpt: String(err?.message || err)
    };
  }
}