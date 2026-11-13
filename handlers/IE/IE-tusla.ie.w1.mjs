export const meta = {
  task: 'IE-tusla.ie',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'tusla_ref', 'service_type', 'age_range', 'county', 'address', 'eircode', 'registered_status', 'conditions', 'registration_date'],
  canary: { found: "Little Moo-Moo's Playschool Ltd", not_found: 'Cuideachta Dhoiléir Theoranta' },
};

// The Tusla Early Years Register (eyir.tusla.ie) is searched by a JSON endpoint that the site's own search box calls:
//   GET https://eyir.tusla.ie/Keyword/Get_Search?searchTerms=<text>  ->  { Data: [ ...services ], Total, Errors }
// The search is not case- or accent-sensitive in the same way for every listing, so the handler asks with the
// name as typed and with its accents removed, then keeps only listings whose normalised name is exactly the company.

const SITE = 'https://eyir.tusla.ie';
const SEARCH_PATH = '/Keyword/Get_Search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped from the end of a name before comparing (Irish and English forms).
const LEGAL_FORMS = new Set(['ltd', 'limited', 'teo', 'teoranta', 'dac', 'clg', 'cic', 'plc', 'uc', 'unlimited', 'company']);

class Check extends Error {
  constructor(reason, url, excerpt) {
    super(reason);
    this.reason = reason;
    this.url = url;
    this.excerpt = excerpt;
  }
}

function deaccent(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function fold(s) {
  return deaccent(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Name without legal form, lower case, letters and digits only: the value two names are compared on. */
function nameKey(s) {
  const t = fold(s).split(' ').filter(Boolean);
  while (t.length && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t.join('');
}

/** The name as typed, minus trailing legal-form words, so the search is not flooded by "Ltd" matches. */
function queryText(s) {
  const parts = String(s || '').trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && LEGAL_FORMS.has(fold(parts[parts.length - 1]))) parts.pop();
  return parts.join(' ');
}

function parseDate(v) {
  const m = /\/Date\((-?\d+)\)\//.exec(String(v || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function toRecord(d) {
  const f = d.Facility || {};
  const a = d.Address || f.Address || {};
  return {
    name: String(d.Facility_Name || '').trim(),
    tusla_ref: String(d.Ref_No || f.Ref_No || '').trim(),
    service_type: String((d.Service_Types && d.Service_Types.Service_Type) || '').trim(),
    age_range: String((d.Age && d.Age.Age_Range) || '').trim(),
    county: String((d.County && d.County.Name) || '').trim(),
    address: [a.Address1, a.Address2, a.Address3, a.Town].map((x) => String(x || '').trim()).filter(Boolean).join(', '),
    eircode: String(a.Eircode || '').trim(),
    registered_status: String((d.Registered_Status && d.Registered_Status.Registered_Status_Type) || '').trim(),
    conditions: String(d.Conditions || '').trim(),
    registration_date: parseDate(d.Registration_Date),
  };
}

async function fetchSearch(term) {
  const url = `${SITE}${SEARCH_PATH}?searchTerms=${encodeURIComponent(term)}`;
  let res;
  let text;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(25000),
    });
    text = await res.text();
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Check(timeout ? 'timeout' : 'other', url, String((e && e.message) || e).slice(0, 300));
  }
  if (res.status === 403 || res.status === 429) throw new Check('blocked', url, `HTTP ${res.status}`);
  if (!res.ok) throw new Check('http_error', url, `HTTP ${res.status}`);

  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!json || !Array.isArray(json.Data)) {
    const looksBlocked = /captcha|challenge|cf-chl|access denied|sign in|log in/i.test(text);
    throw new Check(looksBlocked ? 'blocked' : 'layout_changed', url, text.slice(0, 300));
  }
  if (json.Errors) throw new Check('other', url, JSON.stringify(json.Errors).slice(0, 300));
  return { url, term, total: Number(json.Total) || json.Data.length, data: json.Data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    const key = nameKey(input);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: `${SITE}/`, excerpt: 'no company name left after removing the legal form' };
    }

    const q1 = queryText(input);
    const terms = [q1];
    const plain = deaccent(q1);
    if (plain !== q1) terms.push(plain);

    const settled = await Promise.all(terms.map((t) => fetchSearch(t).catch((e) => e)));
    const ok = settled.filter((r) => !(r instanceof Error));
    const failed = settled.filter((r) => r instanceof Error);

    const seen = new Map();
    for (const r of ok) {
      for (const d of r.data) {
        if (nameKey(d.Facility_Name) !== key) continue;
        const rec = toRecord(d);
        seen.set(JSON.stringify(rec), { rec, url: r.url });
      }
    }

    if (seen.size > 0) {
      const hits = [...seen.values()];
      const first = hits[0].url;
      return {
        status: 'found',
        reason: '',
        records: hits.map((h) => h.rec),
        source_url: first,
        excerpt: `${hits.length} register entr${hits.length === 1 ? 'y' : 'ies'} with this name (search "${q1}")`,
      };
    }

    if (failed.length > 0) {
      const f = failed[0];
      if (f instanceof Check) {
        return { status: 'couldnt_check', reason: f.reason, records: [], source_url: f.url, excerpt: f.excerpt };
      }
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: `${SITE}/`, excerpt: String((f && f.message) || f).slice(0, 300) };
    }

    const total = ok.reduce((n, r) => n + r.total, 0);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: ok[0].url,
      excerpt: total === 0
        ? `register search for "${q1}" returned 0 entries`
        : `register search for "${q1}" returned ${total} entries, none with this name`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `${SITE}/`,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
