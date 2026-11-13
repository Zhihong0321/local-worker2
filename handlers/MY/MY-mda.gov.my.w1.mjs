export const meta = {
  task: 'MY-mda.gov.my',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_no', 'validity', 'licence_types'],
  canary: { found: 'PREMIER DIAGNOSTICS SDN BHD', not_found: 'SYARIKAT TIADA WUJUD SDN BHD' },
};

// The MDA establishment-licence search lives on the MDAR portal (linked from mda.gov.my).
const BASE = 'https://mdar.mda.gov.my/frontend/web/index.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// The site's search is a plain text match: "SDN. BHD." finds nothing, while the name without the legal form does.
// So the legal form and "(M)" are taken out of the text sent to the site.
function searchTerm(keyword) {
  return String(keyword || '')
    .replace(/\(\s*M\s*\)/gi, ' ')
    .replace(/\b(SDN|BHD|BERHAD|PLT)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,-]+|[\s.,-]+$/g, '')
    .trim();
}

// Name key for comparing: upper case, legal form and "(M)" dropped, punctuation and spaces dropped.
function nameKey(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\(\s*M\s*\)/g, ' ')
    .replace(/\b(SDN|BHD|BERHAD|PLT)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function fetchOpts() {
  return {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = '';
  try {
    const term = searchTerm(keyword);
    const want = nameKey(keyword);
    if (!term || !want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no company name left to search' };
    }

    url = `${BASE}?r=carian-el%2Findex&CompletedApplicationElSearch%5BglobalSearch%5D=${encodeURIComponent(term)}`;
    const res = await fetch(url, fetchOpts());
    const html = await res.text();

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status} ${cleanText(html).slice(0, 200)}` };
    }
    if (/Just a moment|cf-chl|challenge-platform/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
    }

    const tableMatch = html.match(/<table id="example1"[\s\S]*?<\/table>/);
    if (!tableMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
    }

    // Data rows carry data-key; the header row and the "No results found" row do not.
    const rows = [...tableMatch[0].matchAll(/<tr data-key="[^"]*">([\s\S]*?)<\/tr>/g)]
      .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => cleanText(c[1])))
      .filter((cells) => cells.length >= 5 && cells[1]);

    if (rows.length === 0) {
      if (/No results found/i.test(tableMatch[0])) {
        return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `No results found for "${term}"` };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(tableMatch[0]).slice(0, 300) };
    }

    const matches = rows.filter((cells) => nameKey(cells[1]) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `${rows.length} establishment(s) matched "${term}", none is this company: ${[...new Set(rows.map((c) => c[1]))].slice(0, 5).join(' ; ')}`.slice(0, 500),
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((cells) => ({
        name: cells[1],
        licence_no: cells[2],
        validity: cells[3],
        licence_types: cells[4],
      })),
      source_url: url,
      excerpt: matches.map((cells) => `${cells[1]} | ${cells[2]} | ${cells[3]} | ${cells[4]}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
