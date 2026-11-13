export const meta = { task: 'IE-psa-gov.ie', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['licence_no', 'name', 'trading_name', 'address', 'country', 'county', 'licence_categories', 'issue_date', 'expiry_date'],
  canary: { found: 'Mac Security Limited', not_found: 'Cuideachta Slándála Teoranta' } };

const PAGE_URL = 'https://www.psa-gov.ie/psa-registered-contractors/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words removed from the END of a normalised name (Irish and English forms).
const LEGAL_FORMS = ['limited', 'ltd', 'teoranta', 'teo', 'dac', 'designated', 'activity', 'company', 'unlimited', 'uc', 'plc', 'llp'];

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', times: '×', raquo: '»', laquo: '«', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function cellText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeName(str) {
  let s = (str || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  let words = s.split(' ').filter(Boolean);
  // strip legal form words from the end, repeatedly ("... Limited" / "... Teoranta" / "... DAC")
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    const last = words[words.length - 1];
    if (LEGAL_FORMS.includes(last)) { words.pop(); changed = true; }
  }
  // "designated activity company" / "unlimited company" end in "company" already handled above
  return words.join(' ');
}

function fail(status, reason, sourceUrl, excerpt) {
  return { status, reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '');
    const kwNorm = normalizeName(kw);
    if (!kwNorm) return fail('couldnt_check', 'other', PAGE_URL, 'empty company name');

    let res;
    try {
      res = await fetch(PAGE_URL, {
        signal: AbortSignal.timeout(25000),
        headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
    } catch (e) {
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return fail('couldnt_check', isTimeout ? 'timeout' : 'other', PAGE_URL, e && e.message);
    }

    // Read the body of error answers too: an unread body leaves a socket open and the worker exits with a crash code.
    if (res.status === 403 || res.status === 429) {
      await res.text().catch(() => {});
      return fail('couldnt_check', 'blocked', PAGE_URL, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      return fail('couldnt_check', 'http_error', PAGE_URL, `HTTP ${res.status}`);
    }

    const html = await res.text();
    if (/captcha|cf-challenge|cf_chl_|Attention Required|Access denied/i.test(html.slice(0, 20000)) && !html.includes('table_2_row_')) {
      return fail('couldnt_check', 'blocked', PAGE_URL, 'bot or challenge page');
    }

    // The register is embedded in the page as the table "table_2" (one <tr> per licensed contractor).
    const rowHtmls = html.match(/<tr id="table_2_row_\d+"[\s\S]*?<\/tr>/g) || [];
    if (rowHtmls.length === 0) {
      return fail('couldnt_check', 'layout_changed', PAGE_URL, html.slice(0, 300));
    }

    const records = [];
    let parsedRows = 0;
    for (const rowHtml of rowHtmls) {
      const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => cellText(c.replace(/^<td[^>]*>|<\/td>$/g, '')));
      if (cells.length < 10) continue;
      parsedRows++;
      const [licenceNo, contractorName, tradingName, address, country, county, categories, , issueDate, expiryDate] = cells;
      const matches = normalizeName(contractorName) === kwNorm || normalizeName(tradingName) === kwNorm;
      if (!matches) continue;
      records.push({
        licence_no: licenceNo,
        name: contractorName,
        trading_name: tradingName,
        address,
        country,
        county,
        licence_categories: categories.split('|').map((x) => x.trim()).filter(Boolean),
        issue_date: issueDate,
        expiry_date: expiryDate,
      });
    }

    if (parsedRows === 0) {
      return fail('couldnt_check', 'layout_changed', PAGE_URL, 'register rows found but without the expected columns');
    }

    if (records.length > 0) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: PAGE_URL,
        excerpt: `${first.licence_no} | ${first.name} | ${first.trading_name} | ${first.address} | ${first.expiry_date}`.slice(0, 300),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `No row of ${parsedRows} registered contractors matches "${kw}"`,
    };
  } catch (err) {
    return fail('couldnt_check', 'other', PAGE_URL, err && err.message ? err.message : err);
  }
}
