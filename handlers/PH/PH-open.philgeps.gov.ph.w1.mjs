export const meta = {
  task: 'PH-open.philgeps.gov.ph',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entity_type', 'status', 'approved_date', 'platinum_number', 'platinum_expiry',
    'mayors_permit', 'mayors_permit_expiry', 'tax_clearance', 'tax_clearance_expiry', 'dti_number', 'dti_expiry'],
  canary: { found: 'DELCON CONSTRUCTION', not_found: 'Hindi Nakalistang Kompanya Xyzqwk' },
};

const PAGE_URL = 'https://open.philgeps.gov.ph/analytics/load/merchantInfo';
const SEARCH_URL = 'https://open.philgeps.gov.ph/analytics/merchant/load/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Legal-form words (letters only, no punctuation). Stripped from the END of names, on both sides.
const LEGAL = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'OPC', 'LLC', 'LLP', 'SDNBHD', 'PTELTD', 'COLTD']);

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Search term sent to the site: the site matches the literal text, so legal-form words typed at the end are removed. */
function searchTerm(keyword) {
  const words = String(keyword || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const key = (w) => w.toUpperCase().replace(/[^A-Z]/g, '');
  while (words.length > 1) {
    const last = key(words[words.length - 1]);
    const two = words.length > 2 ? key(words[words.length - 2]) + last : '';
    if (two && LEGAL.has(two)) words.splice(-2);
    else if (LEGAL.has(last)) words.pop();
    else break;
  }
  return words.join(' ').replace(/[\s,&-]+$/, '');
}

/** Name key used for matching: upper case, punctuation dropped, legal form removed from the end. */
function nameKey(name) {
  const t = String(name || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  while (t.length > 1) {
    const last = t[t.length - 1];
    const two = t.length > 2 ? t[t.length - 2] + last : '';
    if (two && LEGAL.has(two)) t.splice(-2);
    else if (LEGAL.has(last)) t.pop();
    else break;
  }
  return t.join('');
}

function decode(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function text(html) {
  return decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseRows(html) {
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || '';
  const rows = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  let unparsed = 0;
  let noResult = 0;
  for (const row of rows) {
    // The site answers an empty search with one "No Result" row (single cell, colspan 2).
    if (/No Result/i.test(row) && /colspan/i.test(row)) { noResult++; continue; }
    const m = row.match(/<td>([\s\S]*?)<\/td>\s*<th>([\s\S]*?)<\/th>/i);
    if (!m) { unparsed++; continue; }
    const nameCell = m[1];
    const regCell = m[2];
    const link = nameCell.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const name = text(link ? link[1] : nameCell);
    const entityType = text(nameCell.replace(/<a[\s\S]*?<\/a>/i, ''));
    const firstP = regCell.search(/<p[\s>]/i);
    const status = text(firstP >= 0 ? regCell.slice(0, firstP) : regCell);
    const pTexts = (regCell.match(/<p[\s\S]*?<\/p>/gi) || []).map(text);

    const rec = {
      name, entity_type: entityType, status, approved_date: '',
      platinum_number: '', platinum_expiry: '',
      mayors_permit: '', mayors_permit_expiry: '',
      tax_clearance: '', tax_clearance_expiry: '',
      dti_number: '', dti_expiry: '',
    };
    for (const p of pTexts) {
      let x;
      if ((x = p.match(/^Approved Date:\s*(.+)$/i))) rec.approved_date = x[1].trim();
      else if ((x = p.match(/^Mayor'?s Permit:\s*(\S+)\s*\(Exp:\s*([^)]*)\)/i))) { rec.mayors_permit = x[1]; rec.mayors_permit_expiry = x[2].trim(); }
      else if ((x = p.match(/^Tax Clearance:\s*(\S+)\s*\(Exp:\s*([^)]*)\)/i))) { rec.tax_clearance = x[1]; rec.tax_clearance_expiry = x[2].trim(); }
      else if ((x = p.match(/^DTI:\s*(\S+)\s*\(Exp:\s*([^)]*)\)/i))) { rec.dti_number = x[1]; rec.dti_expiry = x[2].trim(); }
      else if ((x = p.match(/^(\S+)\s*\(Exp:\s*([^)]*)\)/i))) { rec.platinum_number = x[1]; rec.platinum_expiry = x[2].trim(); }
    }
    out.push(rec);
  }
  return { rows: out, rawRows: rows.length - noResult, unparsed };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Short pause before answering: on this Windows Node build, the runner's process.exit() right after the last socket
  // to open.philgeps.gov.ph closes hits a libuv assertion (exit 127). The pause lets the sockets close first.
  await new Promise((r) => setTimeout(r, 500));
  return answer;
}

async function search(keyword) {
  try {
    const input = String(keyword || '').trim();
    if (!input) return fail('other', PAGE_URL, 'empty company name');

    // 1. Load the search page: the page carries a template value that its own search request sends.
    const page = await fetch(PAGE_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (page.status === 403 || page.status === 429) return fail('blocked', PAGE_URL, `HTTP ${page.status}`);
    if (!page.ok) return fail('http_error', PAGE_URL, `HTTP ${page.status}`);
    const pageHtml = await page.text();
    const tm = pageHtml.match(/template:\s*'([^']+)'/);
    if (!tm) {
      const blocked = /captcha|cf-chl|Just a moment|Access denied/i.test(pageHtml);
      return fail(blocked ? 'blocked' : 'layout_changed', PAGE_URL, pageHtml.slice(0, 300));
    }

    // 2. Search request, the same POST the page makes.
    const term = searchTerm(input);
    const body = new URLSearchParams({ template: tm[1], keyword: term });
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html, */*; q=0.01' },
      body,
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', PAGE_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', PAGE_URL, `HTTP ${res.status}`);
    const html = await res.text();

    if (!/id="merchant-tbl"/.test(html)) {
      const blocked = /captcha|cf-chl|Just a moment|Access denied/i.test(html);
      return fail(blocked ? 'blocked' : 'layout_changed', PAGE_URL, html.slice(0, 300));
    }

    const { rows, rawRows, unparsed } = parseRows(html);
    if (rows.length === 0 && (rawRows > 0 || unparsed > 0)) return fail('layout_changed', PAGE_URL, 'result rows did not parse');

    // 3. Match the company itself, after normalising names (case, punctuation, legal form).
    const want = nameKey(input);
    const matches = want ? rows.filter((r) => nameKey(r.name) === want) : [];

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
        excerpt: `Search "${term}" returned ${rows.length} row(s); none matched the company name`,
      };
    }

    return {
      status: 'found', reason: '', records: matches, source_url: PAGE_URL,
      excerpt: `Search "${term}": ${matches.map((r) => `${r.name} | ${r.entity_type} | ${r.status}`).join(' ; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', PAGE_URL, String(err?.message || err));
  }
}
