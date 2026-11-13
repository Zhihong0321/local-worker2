export const meta = {
  task: 'US-brokercheck.finra.org',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'firm_source_id', 'bd_sec_number', 'ia_sec_number', 'other_names', 'scope', 'ia_scope',
    'disclosure', 'ia_disclosure', 'branches_count', 'office_address', 'business_phone'],
  canary: { found: 'GOLDMAN SACHS & CO. LLC', not_found: 'Zqxvwpl Nonexistentia Brokerage' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped from the END of a name before comparing (LLC, INC, CO, ...). "L P" is handled as a pair.
const LEGAL = new Set(['llc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation', 'ltd', 'limited', 'llp',
  'plc', 'pllc', 'lc', 'pc', 'gmbh', 'bv', 'sa', 'na', 'pty', 'pte', 'ag', 'srl', 'spa', 'nv', 'ltda']);

/** Lower case, "&" becomes "and", punctuation removed, legal form removed from the end. */
function baseName(str) {
  const t = String(str || '').toLowerCase().replace(/&/g, ' and ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (t.length >= 2 && t[t.length - 2] === 'l' && t[t.length - 1] === 'p') t.length -= 2;
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

function parseJsonField(raw) {
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

function formatOffice(addrDetails) {
  const o = addrDetails.officeAddress;
  if (!o) return '';
  return [o.street1, o.city, [o.state, o.postalCode].filter(Boolean).join(' '), o.country].filter(Boolean).join(', ');
}

function toRecord(s) {
  const addr = parseJsonField(s.firm_address_details);
  const iaAddr = parseJsonField(s.firm_ia_address_details);
  return {
    name: s.firm_name || s.ia_firm_name || '',
    firm_source_id: s.firm_source_id || '',
    bd_sec_number: s.firm_bd_full_sec_number || '',
    ia_sec_number: s.firm_ia_full_sec_number || '',
    other_names: Array.isArray(s.firm_other_names) ? s.firm_other_names : [],
    scope: s.firm_scope || '',
    ia_scope: s.firm_ia_scope || '',
    disclosure: s.firm_disclosure_fl || '',
    ia_disclosure: s.firm_ia_disclosure_fl || '',
    branches_count: s.firm_branches_count ?? null,
    office_address: formatOffice(addr) || formatOffice(iaAddr),
    business_phone: addr.businessPhoneNumber || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `https://api.brokercheck.finra.org/search/firm?query=${encodeURIComponent(keyword)}&hl=true&nrows=50&start=0&r=25&wt=json`;
  try {
    const want = baseName(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
        excerpt: 'the name has no letters or digits to match' };
    }

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { data = null; }
    if (!data || !data.hits || !Array.isArray(data.hits.hits)) {
      const walled = /captcha|access denied|just a moment/i.test(body.slice(0, 2000));
      return { status: 'couldnt_check', reason: walled ? 'blocked' : 'layout_changed', records: [], source_url: searchUrl,
        excerpt: body.slice(0, 300) };
    }

    const hits = data.hits.hits;
    if (hits.length && hits.every((h) => !h || !h._source)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: body.slice(0, 300) };
    }
    const totalRaw = data.hits.total;
    const total = totalRaw && typeof totalRaw === 'object' ? Number(totalRaw.value) : Number(totalRaw);

    // Exact match on the normalised name, against the firm name, the IA name and the other names.
    const matches = [];
    for (const h of hits) {
      const s = h && h._source;
      if (!s) continue;
      const names = [s.firm_name, s.ia_firm_name, ...(Array.isArray(s.firm_other_names) ? s.firm_other_names : [])];
      if (names.some((n) => baseName(n) === want)) matches.push(s);
    }

    if (!matches.length) {
      if (Number.isFinite(total) && total > hits.length) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `${total} results, only the first ${hits.length} were read; no exact name match among them` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${hits.length} result(s), none with the exact name` };
    }

    const records = matches.map(toRecord);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} exact match(es): ${records.map((r) => `${r.name} (firm ${r.firm_source_id})`).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
