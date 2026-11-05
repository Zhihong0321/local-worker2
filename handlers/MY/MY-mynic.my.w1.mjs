export const meta = {
  task: 'MY-mynic.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'url', 'email', 'phone'],
  canary: {
    found: 'Exabytes Network Sdn Bhd',
    not_found: 'O2O Digital',
  },
};

/** Look one company up in MYNIC Authorized Registrars and Resellers directory. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return {
      status: 'couldnt_check',
      reason: 'invalid_input',
      records: [],
      source_url: 'https://mynic.my/resources/domains/find-our-registrars',
      excerpt: '',
    };
  }

  const cleanKeyword = keyword.trim().toLowerCase();
  const pageUrl = 'https://mynic.my/resources/domains/find-our-registrars';
  const ajaxUrl = 'https://mynic.my/ajax/resellers';

  try {
    const getRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!getRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageUrl,
        excerpt: `GET HTTP ${getRes.status}`,
      };
    }

    const html = await getRes.text();
    const tokenMatch = html.match(/name="csrf-token" content="([^"]+)"/);
    if (!tokenMatch) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: 'CSRF token meta tag not found',
      };
    }

    const token = tokenMatch[1];
    const cookies = getRes.headers.getSetCookie ? getRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') : '';

    const postRes = await fetch(ajaxUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRF-TOKEN': token,
        'Cookie': cookies,
      },
      body: 'limit=-1',
      signal: AbortSignal.timeout(15000),
    });

    if (!postRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: ajaxUrl,
        excerpt: `POST HTTP ${postRes.status}`,
      };
    }

    const ajaxHtml = await postRes.text();
    if (!ajaxHtml.includes('resellerbox') && !ajaxHtml.includes('resellertitle')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: ajaxUrl,
        excerpt: 'Expected resellerbox markup not returned',
      };
    }

    const boxes = [...ajaxHtml.matchAll(/<div class="resellerbox">([\s\S]*?)<\/div>\s*<\/div>/gi)];
    const records = [];
    let excerpt = '';

    for (const b of boxes) {
      const boxHtml = b[1];
      const titleMatch = boxHtml.match(/<span class="resellertitle">([\s\S]*?)<\/span>/i);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      const emailMatch = boxHtml.match(/<span class="remail">[^<]*<\/span>\s*<a[^>]*>([^<]+)<\/a>/i);
      const email = emailMatch ? emailMatch[1].trim() : '';
      const urlMatch = boxHtml.match(/<span class="rurl">[^<]*<\/span>\s*<a[^>]*>([^<]+)<\/a>/i);
      const webUrl = urlMatch ? urlMatch[1].trim() : '';
      const phoneMatch = boxHtml.match(/<span class="rphone">[^<]*<\/span>\s*<a[^>]*>([^<]+)<\/a>/i);
      const phone = phoneMatch ? phoneMatch[1].trim() : '';

      const fullText = `${title} ${email} ${webUrl} ${phone}`.toLowerCase();
      if (fullText.includes(cleanKeyword) || cleanKeyword.split(/\s+/).every(w => fullText.includes(w))) {
        records.push({
          name: title,
          url: webUrl,
          email,
          phone,
        });
        if (!excerpt) {
          excerpt = `${title} | URL: ${webUrl} | Email: ${email} | Phone: ${phone}`;
        }
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: pageUrl,
        excerpt: excerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: 'Company not found in MYNIC authorized registrars / resellers list',
    };
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: pageUrl,
      excerpt: e.message || 'Lookup failed',
    };
  }
}
