export const meta = {
  task: 'MY-amcham.com.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'membership_type', 'membership_start', 'membership_end', 'address', 'phone', 'website', 'headquarters', 'corporate_origin', 'sector', 'profile_url'],
  canary: { found: '3M Malaysia Sdn. Bhd.', not_found: 'Syarikat Fiktif Tiada Wujud Sdn Bhd' },
};

// Same request the member directory page sends to its own search box (action GETBYSEARCH).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE = 'https://amcham.com.my';
const PAGE = `${SITE}/amcham-membership-directory-2026/`;
const AJAX = `${SITE}/wp-admin/admin-ajax.php`;

// Legal-form words and the country word, dropped on both sides before comparing names.
const DROP = new Set(['SDN', 'BHD', 'BERHAD', 'PTE', 'LTD', 'LIMITED', 'PLT', 'LLP', 'LLC', 'INC', 'CO', 'COMPANY', 'PRIVATE', 'MALAYSIA', 'M', 'THE']);

/** Upper-case words of a company name, without punctuation, legal form or the country word. */
function nameWords(str) {
  return String(str || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\((M|MALAYSIA)\)/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !DROP.has(w));
}

const keyOf = (words) => words.join('');
const isoDate = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function search(term) {
  const body = new URLSearchParams({ action: 'GETBYSEARCH', _ajax_nonce: 'nonce_name' });
  body.set('payload[search]', term);
  const res = await fetch(AJAX, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': PAGE,
      'Origin': SITE,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, text: await res.text() };
}

/** Returns { fail } or { values } from one search answer. */
function interpret(status, text) {
  if (status === 403 || status === 429 || /captcha|cf-chl|access denied/i.test(text.slice(0, 3000))) {
    return { fail: fail('blocked', PAGE, `HTTP ${status}: ${text.slice(0, 200)}`) };
  }
  if (status !== 200) return { fail: fail('http_error', PAGE, `HTTP ${status}`) };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { fail: fail('layout_changed', PAGE, text.slice(0, 300)) };
  }
  if (json?.success !== true) return { fail: fail('other', PAGE, 'search answered success=false: ' + text.slice(0, 200)) };
  const inner = json.data?.data;
  if (inner?.code !== 200 || !Array.isArray(inner.data?.value)) {
    return { fail: fail('layout_changed', PAGE, text.slice(0, 300)) };
  }
  const total = inner.data.metadata?.pagination?.total;
  if (Number.isFinite(total) && total > inner.data.value.length) {
    return { fail: fail('other', PAGE, `results truncated: total ${total}, received ${inner.data.value.length}`) };
  }
  return { values: inner.data.value };
}

function toRecord(x) {
  const p = x.properties || {};
  const a = x.address || {};
  return {
    name: x.name || '',
    registration_number: p['business-registration-number'] || '',
    membership_type: x.membershipType?.title || '',
    membership_start: isoDate(x.startDate),
    membership_end: isoDate(x.endDate),
    address: [a.streetAddress, a.zipCode, a.cityName, a.province, a.country?.code].filter(Boolean).join(', '),
    phone: x.phone?.value || '',
    website: x.companyWebsiteAddress || '',
    headquarters: p['headquarter-location'] || '',
    corporate_origin: p['corporate-origin']?.title?.en || '',
    sector: p['single_choice-liqp0x1f']?.title?.en || '',
    profile_url: x.membershipId ? `${SITE}/member-details/?membership_id=${x.membershipId}` : PAGE,
  };
}

function excerptOf(r) {
  return [r.name, r.registration_number && `reg. ${r.registration_number}`, r.membership_type && `${r.membership_type} member`, r.address]
    .filter(Boolean).join(' | ').slice(0, 500);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const words = nameWords(keyword);
    const key = keyOf(words);
    if (!key) return fail('other', PAGE, `no company name in "${keyword}"`);

    // First the full name without legal form; then the first word only, to catch spelling differences.
    const terms = [words.join(' ')];
    if (words.length > 1 && words[0].length >= 2) terms.push(words[0]);

    for (let i = 0; i < terms.length; i++) {
      if (i > 0 && Date.now() - started > 25000) return fail('timeout', PAGE, 'not enough time left for the second search');
      const res = await search(terms[i]);
      const parsed = interpret(res.status, res.text);
      if (parsed.fail) return parsed.fail;

      const matches = parsed.values.filter((x) => x?.membershipType?.title !== 'AMCHAM Staff' && keyOf(nameWords(x?.name)) === key);
      if (matches.length) {
        const records = matches.map(toRecord);
        return { status: 'found', reason: '', records, source_url: records[0].profile_url, excerpt: excerptOf(records[0]) };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `Directory search for "${terms.join('" and "')}" returned no company with this name`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', PAGE, String(err?.message || err));
  }
}
