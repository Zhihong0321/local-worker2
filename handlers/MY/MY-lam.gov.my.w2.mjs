export const meta = {
  task: 'MY-lam.gov.my',
  want: 'w2',
  tier: 2,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'registration_number', 'practice_type', 'address', 'contact'],
  canary: { found: 'A. BAKHTIAR ARCHITECT', not_found: 'Dezeno' },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const types = ['SP', 'ABC', 'PT'];
  const lowerKw = keyword.toLowerCase();
  const allRecords = [];
  let bestExcerpt = '';
  let lastUrl = '';

  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (i > 0) await new Promise(r => setTimeout(r, 1000));
    const url = `https://www.lam.gov.my/search-practice?atype=${t}`;
    lastUrl = url;

    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        return {
          status: 'couldnt_check',
          reason: 'http_error',
          records: [],
          source_url: url,
          excerpt: `HTTP status ${res.status}`
        };
      }
      const html = await res.text();
      if (!html.includes('table table-hover') && !html.includes('Name & Registration Number')) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: url,
          excerpt: 'Expected LAM practices table not found on page'
        };
      }

      const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
      let match;
      while ((match = rowRegex.exec(html)) !== null) {
        const rowHtml = match[1];
        if (!rowHtml.includes('special-text')) continue;

        const nameMatch = rowHtml.match(/<div class="special-text">([\s\S]*?)<\/div>/i);
        const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        const regMatch = rowHtml.match(/<\/div>\s*([^<\n\r]+)/i);
        const regNo = regMatch ? regMatch[1].trim() : '';

        const contactMatches = [...rowHtml.matchAll(/<td class="dcontact">([\s\S]*?)<\/td>/gi)];
        const address = contactMatches[0] ? contactMatches[0][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
        const contact = contactMatches[1] ? contactMatches[1][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

        const combinedText = `${name} ${regNo} ${address}`;
        if (combinedText.toLowerCase().includes(lowerKw)) {
          const cleanExcerpt = rowHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
          if (!bestExcerpt) bestExcerpt = cleanExcerpt;
          allRecords.push({
            name,
            registration_number: regNo,
            practice_type: t === 'SP' ? 'Sole Proprietorship' : t === 'ABC' ? 'Body Corporate' : 'Partnership',
            address,
            contact
          });
        }
      }

      if (allRecords.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: allRecords,
          source_url: url,
          excerpt: bestExcerpt
        };
      }
    } catch (e) {
      return {
        status: 'couldnt_check',
        reason: 'timeout',
        records: [],
        source_url: url,
        excerpt: String(e)
      };
    }
  }

  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: lastUrl,
    excerpt: `No architectural consultancy practice records found for "${keyword}" on LAM register.`
  };
}
