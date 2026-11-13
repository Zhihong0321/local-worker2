export const meta = {
  task: 'AU-cleanenergyregulator.gov.au',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'role', 'project_name', 'project_id', 'method_type', 'project_location', 'contract_id', 'contract_status', 'auction_date'],
  canary: { found: 'MUNGALLA ABORIGINAL CORPORATION FOR BUSINESS', not_found: 'Zorbexis Holdings Pty Ltd' },
};

const BASE = 'https://cer.gov.au/markets/reports-and-data/accu-project-and-contract-register';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const LEGAL_FORM = new Set(['pty', 'ltd', 'limited', 'proprietary', 'pl', 'inc', 'incorporated']);

/** Lower-case words of a string (Unicode letters and digits only). */
function words(str) {
  return (str || '').replace(/&/g, ' and ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Comparable form of a company name: case, punctuation and legal form removed. */
function coreKey(str) {
  return words(str).filter((w) => !LEGAL_FORM.has(w)).join(' ');
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every table on the page as rows of cell texts; row 0 is the header row. */
function parseTables(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  return tables.map((t) => (t.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).map((r) => (r.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(cleanText)));
}

/** Header label without the "Sort descending" text the site adds to sortable columns. */
function headerLabels(rows) {
  return rows[0].map((h) => h.replace(/\s*Sort (descending|ascending)$/i, '').trim());
}

function col(labels, cells, label) {
  const i = labels.indexOf(label);
  return i >= 0 ? cells[i] || '' : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = BASE;
  try {
    const name = String(keyword || '').trim();
    const queryWords = name.split(/\s+/).filter((w) => w && !LEGAL_FORM.has(words(w).join(' ')));
    const target = coreKey(name);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name to search for' };
    }

    // The register's own full-text search, given the name without its legal form (the site writes "Pty Limited" etc.).
    searchUrl = `${BASE}?search_api_fulltext=${encodeURIComponent(queryWords.join(' '))}&items_per_page=${PAGE_SIZE}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!/search_api_fulltext/.test(html) || !/Project Proponent/.test(html)) {
      if (/captcha|cf-challenge|Just a moment|Access denied/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const tables = parseTables(html);
    // Project register table: header has "Project ID" and "Project Proponent" (the "since last update" tables do not have Project ID).
    const projectTable = tables.find((rows) => rows.length && headerLabels(rows).includes('Project ID') && headerLabels(rows).includes('Project Proponent'));
    // Contract register table: header has "Contractor Name".
    const contractTable = tables.find((rows) => rows.length && headerLabels(rows).includes('Contractor Name'));

    const records = [];

    if (projectTable) {
      const labels = headerLabels(projectTable);
      for (const cells of projectTable.slice(1)) {
        for (const part of col(labels, cells, 'Project Proponent').split(';')) {
          if (part.trim() && coreKey(part) === target) {
            records.push({
              name: part.trim(),
              role: 'project proponent',
              project_name: col(labels, cells, 'Project Name'),
              project_id: col(labels, cells, 'Project ID'),
              method_type: col(labels, cells, 'Method type'),
              project_location: col(labels, cells, 'Project location'),
              contract_id: col(labels, cells, 'Contract ID'),
            });
          }
        }
      }
    }

    if (contractTable) {
      const labels = headerLabels(contractTable);
      for (const cells of contractTable.slice(1)) {
        for (const part of col(labels, cells, 'Contractor Name').split(';')) {
          if (part.trim() && coreKey(part) === target) {
            records.push({
              name: part.trim(),
              role: 'contract holder',
              project_name: col(labels, cells, 'Project(s)'),
              project_id: col(labels, cells, 'Project ID'),
              contract_id: col(labels, cells, 'Carbon Abatement Contract ID'),
              auction_date: col(labels, cells, 'Auction date'),
              contract_status: col(labels, cells, 'Status'),
            });
          }
        }
      }
    }

    if (records.length) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: `${records.length} register row(s) for ${first.name}: ${first.project_name} (${first.project_id})`.slice(0, 500),
      };
    }

    // A full page with no exact match may hide the company on the next page, so do not call it not_found.
    const projectRows = projectTable ? projectTable.length - 1 : 0;
    const contractRows = contractTable ? contractTable.length - 1 : 0;
    if (projectRows >= PAGE_SIZE || contractRows >= PAGE_SIZE) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: searchUrl,
        excerpt: `search returned ${PAGE_SIZE}+ rows and none matched exactly; the rest of the results were not read`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `ACCU project and contract register search for "${queryWords.join(' ')}": ${projectRows} project row(s), ${contractRows} contract row(s), none for this company`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
