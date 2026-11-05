export const meta = {
  task: 'SG-elitigation.sg',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['case_name', 'court_citation', 'decision_date', 'case_number', 'url'],
  canary: {
    found: 'TERRAFORM LABS PTE. LTD.',
    not_found: 'Space Factor'
  }
};

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = (keyword || '').trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://www.elitigation.sg/gd/',
        excerpt: ''
      };
    }

    const searchUrl = `https://www.elitigation.sg/gd/?searchPhrase=${encodeURIComponent('"' + cleanKeyword + '"')}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP ${res.status} ${res.statusText}`
      };
    }

    const html = await res.text();

    // Layout verification
    const hasMarker = html.includes('search') || html.includes('Total Judgment(s) Found') || html.includes('gd-heardertext');
    if (!hasMarker) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: html.slice(0, 300)
      };
    }

    const countMatch = html.match(/Total Judgment\(s\) Found\s*:\s*(\d+)/i);
    const totalFound = countMatch ? parseInt(countMatch[1], 10) : null;

    if (totalFound === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: 'Total Judgment(s) Found : 0'
      };
    }

    // Split by card container
    const cardSections = html.split(/<div\b[^>]*class="[^"]*gd-card-body[^"]*"[^>]*>/i).slice(1);
    const records = [];

    for (const cardHtml of cardSections) {
      // Title & URL
      const titleMatch = cardHtml.match(/<a\b([^>]*class="[^"]*gd-heardertext[^"]*"[^>]*)>([\s\S]*?)<\/a>/i);
      const hrefMatch = titleMatch ? titleMatch[1].match(/href=['"]([^'"]+)['"]/i) : null;
      const relativeUrl = hrefMatch ? hrefMatch[1].trim() : '';
      const caseName = titleMatch ? decodeEntities(titleMatch[2].replace(/<[^>]+>/g, '')).trim() : '';

      // Citation
      const citationMatch = cardHtml.match(/class="citation-num-link"[^>]*>[\s\S]*?<span class="gd-addinfo-text">\s*([^|<]+)/i);
      const citation = citationMatch ? decodeEntities(citationMatch[1]).trim() : '';

      // Decision Date
      const dateMatch = cardHtml.match(/class="decision-date-link"[^>]*>[\s\S]*?<span class="gd-addinfo-text">\s*Decision Date:\s*([^|<]+)/i);
      const decisionDate = dateMatch ? decodeEntities(dateMatch[1]).trim() : '';

      // Case Number
      const caseNumMatch = cardHtml.match(/class="case-num-link"[^>]*>[\s\S]*?<span class="gd-addinfo-text">\s*([^<]+)/i);
      const caseNumber = caseNumMatch ? decodeEntities(caseNumMatch[1]).trim() : '';

      if (caseName) {
        records.push({
          case_name: caseName,
          court_citation: citation,
          decision_date: decisionDate,
          case_number: caseNumber,
          url: relativeUrl.startsWith('http') ? relativeUrl : `https://www.elitigation.sg${relativeUrl}`
        });
      }
    }

    if (records.length > 0) {
      const excerptMatch = html.match(/<div class="gd-card-body">[\s\S]{0,500}/);
      const excerpt = excerptMatch ? excerptMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : '';

      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: countMatch ? countMatch[0] : ''
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.elitigation.sg/gd/',
      excerpt: err.message || String(err)
    };
  }
}
