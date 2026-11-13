export const meta = {
  task: 'AE-dubaisouth.ae',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'license_number', 'legal_frame', 'issue_date', 'expiry_date', 'general_manager', 'activities', 'address', 'company_id'],
  canary: {
    found: 'BMW Middle East Retail Competency Centre DWC-LLC',
    not_found: 'شركة الواحة الذهبية للتجارة العامة ذ.م.م',
  },
};

const DIRECTORY_URL = 'https://www.dubaisouth.ae/api/sales-force/company-directory';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that the site or the user may add; they do not change which company it is.
const LEGAL_TOKENS = new Set(['llc', 'fze', 'fzco', 'fzc', 'fz', 'dwc', 'branch', 'ltd', 'limited', 'llp', 'co', 'inc', 'pjsc', 'dmcc', 'sole', 'proprietorship', 'establishment']);

/** Normalised company name: lower case, punctuation removed, legal form removed, words kept in order. */
function coreName(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  t = t.replace(/l\.\s*l\.\s*c\.?/g, ' llc ');   // L.L.C
  t = t.replace(/ذ\s*\.?\s*م\s*\.?\s*م\s*\.?/g, ' llc '); // ذ.م.م (Arabic LLC)
  t = t.replace(/&/g, ' and ');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_TOKENS.has(w)).join(' ');
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = coreName(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'the keyword has no company name in it' };
    }

    const res = await fetch(DIRECTORY_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (/captcha|challenge-platform|cf-chl/i.test(text.slice(0, 5000))) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: 'bot check page instead of data' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: text.slice(0, 300) };
    }

    const list = json && json.data && json.data.CompanyDirectory;
    if (json.success !== true || !Array.isArray(list)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: `keys: ${Object.keys(json || {}).join(', ')}` };
    }
    if (list.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'the directory came back empty, so no answer can be given' };
    }

    const matches = list.filter((r) => r && typeof r.companyName === 'string' && coreName(r.companyName) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: DIRECTORY_URL,
        excerpt: `0 of ${list.length} directory entries match "${keyword}"`,
      };
    }

    const records = matches.map((r) => ({
      name: r.companyName,
      license_number: r.licenseNumber ?? null,
      legal_frame: r.legalFrame ?? null,
      issue_date: r.licenseIssueDate ?? null,
      expiry_date: r.licenseexpiryDate ?? null,
      general_manager: r.generalManager ?? null,
      activities: Array.isArray(r.lstActivities) ? r.lstActivities : [],
      address: oneLine(r.address),
      company_id: r.companyId ?? null,
    }));

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: DIRECTORY_URL,
      excerpt: `${first.name} | licence ${first.license_number} | ${first.legal_frame} | expires ${first.expiry_date}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: DIRECTORY_URL,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
