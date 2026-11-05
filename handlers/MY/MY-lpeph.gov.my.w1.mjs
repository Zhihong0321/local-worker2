export const meta = {
  task: 'MY-lpeph.gov.my',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'registration_no', 'firm_type', 'address', 'state', 'phone', 'email', 'website'],
  canary: { found: 'CHESTER PROPERTIES SDN BHD', not_found: 'O2O Digital' },
  notes:
    'The public firm register of LPEPH/BOVAEP lives on the Board Information System (bis.lpeph.gov.my/search), ' +
    'reached from the portal. A plain GET with ?category=firm&name=<name> returns the result set as JSON ' +
    'inside the Inertia "data-page" attribute (no JS needed). The main portal lpeph.gov.my itself carries no ' +
    'firm records: its own CMS search is empty and /search-listing is an empty shell.',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const STATE_CODES = {
  1: 'PERAK', 2: 'SABAH', 3: 'SARAWAK', 4: 'PULAU PINANG', 5: 'MELAKA', 6: 'NEGERI SEMBILAN',
  7: 'KEDAH', 8: 'KELANTAN', 9: 'JOHOR', 10: 'PAHANG', 11: 'TERENGGANU', 12: 'PERLIS',
  13: 'KUALA LUMPUR', 14: 'SELANGOR', 15: 'WILAYAH PERSEKUTUAN PUTRAJAYA', 16: 'WILAYAH PERSEKUTUAN LABUAN',
};

const FIRM_TYPES = {
  1: 'Appraiser', 2: 'Estate Agent', 3: 'Valuer', 4: 'Appraisal And Estate Agency',
  5: 'Property Management', 6: 'Estate Agency And Property Management', 7: 'Non Firm',
  8: 'Valuer And Estate Agency', 10: 'Valuer, Estate Agency And Property Management',
  11: 'Valuer And Property Manager',
};

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&#x0*22;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function clean(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s || s === '-' || s.toLowerCase() === 'null') return '';
  return s;
}

function buildAddress(row) {
  return [row.business_address1, row.business_address2, row.business_address3, row.business_postcode, row.business_district]
    .map(clean)
    .filter(Boolean)
    .join(', ');
}

export default async function lookup(keyword) {
  const kw = typeof keyword === 'string' ? keyword.trim() : '';
  if (kw.length < 2) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'keyword too short' };
  }

  const url =
    'https://bis.lpeph.gov.my/search?category=firm&name=' + encodeURIComponent(kw);

  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
  } catch (e) {
    const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String((e && e.message) || e).slice(0, 200),
    };
  }

  if (res.status === 403 || res.status === 429 || res.status === 503) {
    return {
      status: 'couldnt_check',
      reason: 'blocked',
      records: [],
      source_url: url,
      excerpt: 'HTTP ' + res.status,
    };
  }
  if (!res.ok) {
    return {
      status: 'couldnt_check',
      reason: 'http_error',
      records: [],
      source_url: url,
      excerpt: 'HTTP ' + res.status,
    };
  }

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: url, excerpt: 'read failed' };
  }

  const m = html.match(/data-page="([^"]*)"/);
  if (!m) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: url,
      excerpt: 'Inertia data-page attribute missing',
    };
  }

  let page;
  try {
    page = JSON.parse(decodeEntities(m[1]));
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: url,
      excerpt: 'data-page is not valid JSON',
    };
  }

  const props = page && page.props;
  const items = props && props.items;
  if (
    page.component !== 'Public/Search' ||
    !items ||
    typeof items !== 'object' ||
    !Array.isArray(items.data) ||
    typeof items.total !== 'number'
  ) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: url,
      excerpt: 'unexpected page structure: component=' + String(page && page.component),
    };
  }

  const rows = items.data;
  if (items.total === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url,
      excerpt: 'Register search for "' + kw + '" returned 0 firms (no record of this firm).',
    };
  }

  if (rows.length === 0) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: url,
      excerpt: 'total=' + items.total + ' but no rows on page 1',
    };
  }

  const records = rows.slice(0, 10).map((row) => ({
    name: clean(row.firm_name),
    registration_no: clean(row.firm_registration_no),
    firm_type: FIRM_TYPES[row.type_id] || clean(row.type_id),
    address: buildAddress(row),
    state: STATE_CODES[row.business_state_id] || clean(row.business_state_id),
    phone: clean(row.tel_no) || clean(row.mobile_no),
    email: clean(row.email_address),
    website: clean(row.website),
  }));

  const excerpt = records
    .slice(0, 4)
    .map((r) => [r.name, r.registration_no, r.firm_type, r.state].filter(Boolean).join(' | '))
    .join(' ;; ')
    .slice(0, 500);

  return {
    status: 'found',
    reason: '',
    records,
    source_url: url,
    excerpt: 'Register total ' + items.total + ' firm record(s) for "' + kw + '": ' + excerpt,
  };
}
