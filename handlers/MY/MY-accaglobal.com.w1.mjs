// ACCA Approved Employer directory (Malaysia).
// The public page https://www.accaglobal.com/gb/en/help/approved-employer.html
// calls this JSON API with the client_id embedded in data-api-id. A GET without
// that header returns 401, so this is not a plain tier-1 URL.
export const meta = {
  task: 'MY-accaglobal.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'grade', 'country', 'website', 'account_reference', 'approval_types', 'scope', 'matched_as'],
  canary: { found: 'YYC Holdings Sdn Bhd', not_found: '99 Speed Mart' },
};

const API = 'https://api.apps.accaglobal.com/web2/api/v1/public/directories/employers';
const CLIENT_ID = 'b9c38acbd10a421da7748e903405fb94';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HOME = 'https://www.accaglobal.com/gb/en/help/approved-employer.html';
const PAGE = 20;
const MAX_PAGES = 4;

const STOP = new Set([
  'advisors', 'advisor', 'advisory', 'associates', 'associate', 'consultants', 'consultant',
  'consulting', 'accounting', 'accountants', 'accountancy', 'services', 'service', 'management',
  'holdings', 'holding', 'group', 'sdn', 'bhd', 'berhad', 'plt', 'plc', 'ltd', 'limited', 'inc',
  'llc', 'pte', 'company', 'firm', 'firms', 'the', 'and', 'tax', 'audit', 'partners', 'partnership',
  'chartered', 'international', 'malaysia', 'solutions', 'solution', 'resources', 'enterprise',
  'enterprises', 'corporation', 'corp', 'global', 'office', 'offices', 'professional',
  'professionals', 'practice', 'public', 'certified',
]);

let nextSlot = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = now + wait + 1000;
  if (wait) await sleep(wait);
  return fetch(url, {
    headers: {
      Accept: 'application/json',
      client_id: CLIENT_ID,
      'User-Agent': UA,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
}

function norm(value) {
  let text = String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = text
    .replace(/\b(sdn|bhd|berhad|plt|plc|ltd|limited|inc|llc|pte)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 2 ? stripped : text;
}

function namesMatch(keyword, candidate) {
  const left = norm(keyword);
  const right = norm(candidate);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 4 && right.includes(left)) return true;
  if (right.length >= 4 && left.includes(right) && left.split(' ').length <= right.split(' ').length + 1) return true;
  const tokens = left.split(' ').filter((token) => token.length >= 3);
  if (tokens.length >= 2 && tokens.every((token) => right.split(' ').includes(token))) return true;
  return false;
}

function candidateNames(employer) {
  const names = [];
  if (employer && employer.name) names.push(employer.name);
  for (const approval of employer?.approvals || []) {
    for (const location of approval?.locations || []) {
      if (location?.name) names.push(location.name);
    }
  }
  return names;
}

function employerMatches(keyword, employer) {
  const names = candidateNames(employer);
  const hit = names.find((name) => namesMatch(keyword, name));
  return hit || '';
}

function distinctiveToken(keyword) {
  const tokens = norm(keyword)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP.has(token));
  if (!tokens.length) return '';
  return tokens.slice().sort((a, b) => b.length - a.length)[0];
}

function couldnt(reason, sourceUrl, excerpt) {
  return {
    status: 'couldnt_check',
    reason,
    records: [],
    source_url: sourceUrl || HOME,
    excerpt: String(excerpt || '').slice(0, 500),
  };
}

function recordOf(employer, matchedAs) {
  const approvals = Array.isArray(employer.approvals) ? employer.approvals : [];
  const grades = [...new Set(approvals.map((item) => item && item.approvalStatus).filter(Boolean))];
  const types = [...new Set(approvals.map((item) => item && item.approvalType).filter(Boolean))];
  const scopes = [...new Set(approvals.map((item) => item && item.scope).filter(Boolean))];
  return {
    name: employer.name,
    grade: grades.join('; '),
    country: employer.countryName || '',
    website: employer.websiteAddress || '',
    account_reference: employer.accountReference || '',
    approval_types: types.join('; '),
    scope: scopes.join('; '),
    matched_as: matchedAs,
  };
}

async function searchOnce(query, offset) {
  const url = new URL(API);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(PAGE));
  url.searchParams.set('country', 'MY');
  url.searchParams.set('search', query);
  const sourceUrl = url.toString();
  let response;
  try {
    response = await politeFetch(url);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const reason = /timeout|aborted/i.test(message) ? 'timeout' : 'http_error';
    return { error: couldnt(reason, sourceUrl, message) };
  }
  const text = await response.text();
  const head = text.slice(0, 700);
  if (
    response.status === 403
    || response.status === 429
    || (/<html/i.test(head) && /captcha|cloudflare|just a moment|access denied|sign in|log in/i.test(head))
  ) {
    return { error: couldnt('blocked', sourceUrl, `HTTP ${response.status} ${head}`) };
  }
  if (!response.ok) {
    return { error: couldnt('http_error', sourceUrl, `HTTP ${response.status} ${head}`) };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: couldnt('layout_changed', sourceUrl, head) };
  }
  if (typeof data.total !== 'number' || !Array.isArray(data.employers)) {
    return { error: couldnt('layout_changed', sourceUrl, head) };
  }
  if (data.total > 0 && data.employers.length > 0 && data.employers.every((item) => !item || typeof item.name !== 'string')) {
    return { error: couldnt('layout_changed', sourceUrl, 'employers missing name') };
  }
  return { data, sourceUrl };
}

async function findMatches(query, keyword) {
  const matches = [];
  const seen = new Set();
  let offset = 0;
  let total = 0;
  let sourceUrl = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await searchOnce(query, offset);
    if (result.error) return result;
    sourceUrl = result.sourceUrl;
    total = result.data.total;
    if (!result.data.employers.length) break;
    for (const employer of result.data.employers) {
      const matchedAs = employerMatches(keyword, employer);
      const id = employer && (employer.accountReference || employer.name);
      if (matchedAs && !seen.has(id)) {
        seen.add(id);
        matches.push(recordOf(employer, matchedAs));
      }
    }
    offset += result.data.employers.length;
    if (matches.length || offset >= total) break;
  }
  return { matches, total, sourceUrl };
}

export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return couldnt('other', HOME, 'empty keyword');

    const primary = await findMatches(name, name);
    if (primary.error) return primary.error;
    let records = primary.matches;
    let sourceUrl = primary.sourceUrl;
    let note = `search total ${primary.total}`;

    if (!records.length) {
      const token = distinctiveToken(name);
      if (token && token !== norm(name)) {
        const secondary = await findMatches(token, name);
        if (secondary.error) return secondary.error;
        records = secondary.matches;
        sourceUrl = secondary.sourceUrl;
        note = `full-name total ${primary.total}; token "${token}" total ${secondary.total}`;
      }
    }

    if (!records.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl || HOME,
        excerpt: `No ACCA Approved Employer in Malaysia matched "${name}" (${note}).`.slice(0, 500),
      };
    }

    const first = records[0];
    const detail = first.account_reference
      ? `https://www.accaglobal.com/gb/en/help/approved-employer-details.html?id=${encodeURIComponent(first.account_reference)}`
      : sourceUrl;
    const excerpt = records
      .map((record) => `${record.name} | ${record.grade} | matched ${record.matched_as} | ${record.website}`)
      .join(' || ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: detail,
      excerpt: excerpt.slice(0, 500),
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const reason = /timeout|aborted/i.test(message) ? 'timeout' : 'other';
    return couldnt(reason, HOME, message);
  }
}
