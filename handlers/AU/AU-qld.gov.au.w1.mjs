export const meta = {
  task: 'AU-qld.gov.au',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_number', 'licence_type', 'expiry_date', 'as_at_date'],
  canary: { found: 'AUSTRALIAN SECURITY COMPANY PTY. LIMITED', not_found: 'ZYXQWV HOLDINGS PTY LTD' },
};

// Queensland Fair Trading Licensing Register (linked from https://www.qld.gov.au/law/fair-trading):
// the search form on https://ftlr.fairtrading.qld.gov.au calls a plain GET endpoint that returns JSON.
// Only the company-name search is used; the association/charity register holds no companies.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_URL = 'https://ftlr.fairtrading.qld.gov.au/home/search';

// Legal-form words, dropped before searching and before comparing names.
const LEGAL_FORM = new Set(['PTY', 'LTD', 'LIMITED', 'INC', 'INCORPORATED', 'LLC', 'LLP', 'PLC', 'SDN', 'BHD']);

function tokens(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function coreTokens(name) {
  const all = tokens(name);
  const core = all.filter((t) => !LEGAL_FORM.has(t));
  return core.length ? core : all;
}

/** Same company = same normalised name without the legal form (case, punctuation, PTY/LTD/LIMITED ignored). */
function sameName(registered, keyword) {
  const a = coreTokens(registered).join(' ');
  const b = coreTokens(keyword).join(' ');
  return a !== '' && a === b;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const search = coreTokens(name).join(' ');
  const url = `${SEARCH_URL}?${new URLSearchParams({ LicenceNumber: '', GivenName: '', LastName: '', CompanyName: search, MasterType: '' }).toString()}`;
  try {
    if (!search) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: url, excerpt: 'no company name given' };
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const body = await res.text();
    let rows = null;
    try { rows = JSON.parse(body); } catch { rows = null; }
    if (!Array.isArray(rows)) {
      const blocked = /captcha|access denied|are you a robot/i.test(body);
      return {
        status: 'couldnt_check',
        reason: blocked ? 'blocked' : 'layout_changed',
        records: [],
        source_url: url,
        excerpt: body.replace(/\s+/g, ' ').slice(0, 300),
      };
    }

    const records = rows
      .filter((r) => sameName(r.licenceHolder, name))
      .map((r) => ({
        name: r.licenceHolder,
        licence_number: r.licenceNumber,
        licence_type: r.licenceType,
        expiry_date: r.expiryDateStr || '',
        as_at_date: r.asAtDateStr || '',
      }));

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: url,
        excerpt: `${records.length} licence record(s) for "${name}": ` +
          records.map((r) => `${r.licence_number} ${r.name} (${r.licence_type})`).join('; ').slice(0, 400),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url,
      excerpt: `0 matching licence records for "${name}" (search "${search}", ${rows.length} rows returned)`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
