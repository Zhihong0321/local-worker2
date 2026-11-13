export const meta = {
  task: 'AU-acma.gov.au',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_number', 'acn_abn', 'status', 'date_granted', 'date_surrendered_or_cancelled', 'matched_on'],
  canary: { found: '10Radio Pty Ltd', not_found: 'Zzyzx Quantum Holdings Pty Ltd' },
};

const REGISTER_URL = 'https://www.acma.gov.au/register-licensed-carriers';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalised comparison key: upper case, punctuation removed, legal-form words removed.
const LEGAL_WORDS = /\b(PTY|LTD|LIMITED|PROPRIETARY|CO|COMPANY|INC|INCORPORATED|LLC|CORP|CORPORATION)\b/g;
function core(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(LEGAL_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (!core(keyword)) return fail('other', REGISTER_URL, 'empty company name');

    const res = await fetch(REGISTER_URL, {
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', REGISTER_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', REGISTER_URL, `HTTP ${res.status}`);

    const html = await res.text();
    const hasRegister = /Register of licensed carriers/i.test(html) && /Carrier licence number/i.test(html);
    if (!hasRegister) {
      if (/captcha|access denied|request blocked|bot check/i.test(html)) return fail('blocked', REGISTER_URL, html.slice(0, 200));
      return fail('layout_changed', REGISTER_URL, decode(html).slice(0, 300));
    }
    // The page must hold all four letter sections, otherwise a lookup could wrongly say not_found.
    const sections = ['(A-C)', '(D-I)', '(J-R)', '(S-Z)'];
    if (!sections.every((s) => html.includes(s))) return fail('layout_changed', REGISTER_URL, 'register sections missing');

    // Parse every register row: licence number, carrier name, ACN/ABN, status, dates.
    const entries = [];
    for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(decode);
      if (cells.length < 6 || !/^\d+$/.test(cells[0])) continue;
      if (!/^(current|surrendered|cancelled|canceled)/i.test(cells[3])) continue;
      const rawName = cells[1];
      const formerMatch = rawName.match(/\(formerly\s+([^)]+)\)/i);
      const mainName = rawName.replace(/\(formerly[^)]*\)/i, '').trim();
      entries.push({
        licence_number: cells[0],
        name: mainName,
        former_name: formerMatch ? formerMatch[1].trim() : '',
        acn_abn: cells[2],
        status: cells[3],
        date_granted: cells[4],
        date_surrendered_or_cancelled: cells[5],
      });
    }
    if (entries.length < 100) return fail('layout_changed', REGISTER_URL, `only ${entries.length} register rows parsed`);

    const key = core(keyword);
    const records = [];
    for (const e of entries) {
      let matched_on = '';
      if (core(e.name) === key) matched_on = 'name';
      else if (e.former_name && core(e.former_name) === key) matched_on = 'former name';
      if (!matched_on) continue;
      records.push({
        name: e.name,
        licence_number: e.licence_number,
        acn_abn: e.acn_abn,
        status: e.status,
        date_granted: e.date_granted,
        date_surrendered_or_cancelled: e.date_surrendered_or_cancelled,
        matched_on,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: REGISTER_URL,
        excerpt: `No carrier licence entry matches "${keyword}" (register has ${entries.length} entries)`,
      };
    }
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: REGISTER_URL,
      excerpt: `${first.name}: licence ${first.licence_number}, ${first.status}, ACN/ABN ${first.acn_abn}`,
    };
  } catch (e) {
    const n = e && e.name;
    if (n === 'TimeoutError' || n === 'AbortError') return fail('timeout', REGISTER_URL, 'no answer within 25 s');
    return fail('other', REGISTER_URL, 'handler error: ' + String(e && e.message || e).slice(0, 200));
  }
}
