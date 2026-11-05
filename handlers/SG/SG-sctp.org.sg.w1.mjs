export const meta = {
  task: 'SG-sctp.org.sg',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'individual or company name',
  fields: ['title', 'name', 'accreditation', 'specialisation', 'company'],
  canary: { found: 'Aaron Lee Kong Tzung', not_found: 'Verz Design' }
};

export default async function lookup(keyword) {
  const source_url = 'https://www.sctp.org.sg/Members.aspx?from=bc';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  async function query(name, company) {
    const getRes = await fetch(source_url, { headers });
    if (!getRes.ok) {
      return { ok: false, error: 'http_error', status: getRes.status };
    }
    const cookies = getRes.headers.getSetCookie ? getRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') : (getRes.headers.get('set-cookie') || '');

    const postRes = await fetch('https://www.sctp.org.sg/Members.aspx/SearchFilter', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Cookie': cookies,
        'Referer': source_url
      },
      body: JSON.stringify({
        name,
        company,
        accreditation: 'All',
        specialisation: 'All'
      })
    });

    if (!postRes.ok) {
      return { ok: false, error: 'http_error', status: postRes.status };
    }

    const res = await fetch('https://www.sctp.org.sg/Members.aspx?L=&from=bc', {
      headers: {
        ...headers,
        'Cookie': cookies
      }
    });

    if (!res.ok) {
      return { ok: false, error: 'http_error', status: res.status };
    }

    const text = await res.text();
    // Layout check: Verify search interface markers exist
    if (!text.includes("Members' Directory") || !text.includes('txtNameContaining')) {
      return { ok: false, error: 'layout_changed', text };
    }

    // If no results, table is omitted
    if (!text.includes('id="example"') || !text.includes('tbDirectory')) {
      return { ok: true, rows: [], text };
    }

    const tbodyMatch = text.match(/<tbody id="tbDirectory"[^>]*>([\s\S]*?)<\/tbody>/i);
    let rows = [];
    if (tbodyMatch) {
      rows = [...tbodyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/\s*tr\s*>/gi)].map(r => {
        const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].trim());
        return {
          title: cells[0] || '',
          name: cells[1] || '',
          accreditation: cells[2] || '',
          specialisation: cells[3] || '',
          company: cells[4] || '',
          raw: r[0]
        };
      });
    }

    return { ok: true, rows, text };
  }

  try {
    const term = keyword.trim();
    if (!term) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: ''
      };
    }

    // 1. Search by person name
    let res = await query(term, '');
    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: res.error,
        records: [],
        source_url,
        excerpt: `Failed on query: ${res.error}`
      };
    }

    if (res.rows.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: res.rows.map(r => ({
          title: r.title,
          name: r.name,
          accreditation: r.accreditation,
          specialisation: r.specialisation,
          company: r.company
        })),
        source_url,
        excerpt: res.rows[0].raw.slice(0, 500)
      };
    }

    // 2. Search by company name
    res = await query('', term);
    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: res.error,
        records: [],
        source_url,
        excerpt: `Failed on query: ${res.error}`
      };
    }

    if (res.rows.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: res.rows.map(r => ({
          title: r.title,
          name: r.name,
          accreditation: r.accreditation,
          specialisation: r.specialisation,
          company: r.company
        })),
        source_url,
        excerpt: res.rows[0].raw.slice(0, 500)
      };
    }

    // 3. Search with stripped company name if applicable
    const stripped = term.replace(/\b(pte|ltd|singapore|llp|services|group|holdings)\b/gi, '').trim();
    if (stripped && stripped.toLowerCase() !== term.toLowerCase()) {
      res = await query('', stripped);
      if (res.ok && res.rows.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: res.rows.map(r => ({
            title: r.title,
            name: r.name,
            accreditation: r.accreditation,
            specialisation: r.specialisation,
            company: r.company
          })),
          source_url,
          excerpt: res.rows[0].raw.slice(0, 500)
        };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: ''
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
