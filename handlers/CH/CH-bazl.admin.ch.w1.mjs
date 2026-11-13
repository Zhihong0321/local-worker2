export const meta = {
  task: 'CH-bazl.admin.ch',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration', 'status', 'aircraft_model', 'manufacturer', 'icao_code', 'holder_category', 'holder_address'],
  canary: { found: 'Fliegerschule Birrfeld AG', not_found: 'Zxqvb Nichtexistierende Luftfahrt GmbH' },
};

// Swiss Online-Luftfahrzeugregister (FOCA). The Angular app POSTs JSON to this backend; no login, no token.
const API = 'https://app02.bazl.admin.ch/web/bazl-backend/lfr';
const PAGE_URL = 'https://app02.bazl.admin.ch/web/bazl/de/#/lfr/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const STATUSES = ['Registered', 'Registration in Progress', 'Reserved', 'Reservation Expired', 'Deregistered'];

// Legal forms, as normalised (lowercase, letters and digits only, separators as spaces).
const LEGAL_FORMS = new Set([
  'ag', 'sa', 's a', 'gmbh', 'sarl', 's a r l', 'sagl', 'ltd', 'limited', 'inc', 'llc', 'llp', 'lp', 'plc', 'corp',
  'corporation', 'kg', 'co', 'se', 'ug', 'ohg', 'gbr', 'eg', 'ltda', 'srl', 's r l', 'spa', 'bv', 'nv', 'ab', 'oy',
  'sdn bhd', 'pte ltd', 'genossenschaft', 'cooperative', 'aktiengesellschaft', 'societe anonyme',
  'gesellschaft mit beschrankter haftung', 'societe a responsabilite limitee',
]);

function normalize(s) {
  return String(s || '')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Drop trailing legal-form words from a name, keeping the original spelling of the rest. */
function splitLegalForm(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
      if (LEGAL_FORMS.has(normalize(words.slice(words.length - n).join(' ')))) {
        words.splice(words.length - n, n);
        changed = true;
        break;
      }
    }
  }
  return words.join(' ').replace(/[\s.,;:&+-]+$/g, '');
}

function coreKey(raw) {
  return normalize(splitLegalForm(raw));
}

/** True when the register's holder name is the same company as the keyword (case, punctuation, legal form ignored). */
function sameCompany(keyword, holderName) {
  const key = coreKey(keyword);
  if (!key) return false;
  if (coreKey(holderName) === key) return true;
  // Some holders are written "Company GmbH, Town (DE), c/o ...". Use the part before the comma only when it carries a legal form.
  const comma = holderName.indexOf(',');
  if (comma > 0) {
    const head = holderName.slice(0, comma).trim();
    if (splitLegalForm(head).length < head.length && coreKey(head) === key) return true;
  }
  return false;
}

function addressText(a) {
  if (!a) return '';
  const clean = (v) => (v && v !== 'N/A' ? String(v).trim() : '');
  return [
    [clean(a.street), clean(a.streetNo)].filter(Boolean).join(' '),
    [clean(a.zipCode), clean(a.city)].filter(Boolean).join(' '),
    clean(a.country),
  ].filter(Boolean).join(', ');
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt || '').slice(0, 300) };
}

async function searchPage(term, page) {
  const body = {
    queryProperties: {
      registration: '', aircraftStatus: STATUSES, owner: '', person: term, icao: '', aircraftWorksNumber: '',
      aircraftModelCat: '', aircraftModelType: '', aircraftAssignment: '', engineModelCat: '', ela: '', elt: '',
      icaoCode: '', marketing: '',
    },
    page_result_limit: PAGE_SIZE,
    current_page_number: page,
    sort_list: 'registration',
    language: 'en',
  };
  return fetch(API, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const raw = String(keyword || '').trim();
    const term = splitLegalForm(raw);
    if (!coreKey(raw)) return fail('other', 'the name has no words besides the legal form');

    const matches = [];
    let rowsSeen = 0;
    let truncated = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > 40000) return fail('timeout', 'the register search ran past 40 s');
      const res = await searchPage(term, page);
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

      const text = await res.text();
      let rows;
      try {
        rows = JSON.parse(text);
      } catch {
        return fail(/captcha|access denied|forbidden/i.test(text) ? 'blocked' : 'layout_changed', text.slice(0, 200));
      }
      if (!Array.isArray(rows)) return fail('layout_changed', text.slice(0, 200));

      rowsSeen += rows.length;
      for (const row of rows) {
        for (const holder of row.ownerOperators || []) {
          const holderName = holder.ownerOperator || '';
          if (!sameCompany(raw, holderName)) continue;
          matches.push({
            name: holderName,
            registration: row.registration || '',
            status: row.status || '',
            aircraft_model: row.aircraftModelType || '',
            manufacturer: row.manufacturer || '',
            icao_code: row.icaoCode || '',
            holder_category: holder.holderCategory?.categoryNames?.en || '',
            holder_address: addressText(holder.address),
          });
        }
      }

      if (rows.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) truncated = true;
    }

    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: PAGE_URL,
        excerpt: `${matches.length} register entr${matches.length === 1 ? 'y' : 'ies'}; ${first.registration} ${first.name} (${first.status})`.slice(0, 300),
      };
    }
    if (truncated) return fail('other', `more than ${PAGE_SIZE * MAX_PAGES} aircraft match "${term}"; no exact match in the pages read`);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `0 holder names matched "${raw}" (${rowsSeen} aircraft returned for the search term "${term}")`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', err?.message || err);
  }
}
