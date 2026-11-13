export const meta = {
  task: 'PH-verification.fda.gov.ph',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['category', 'matched_field', 'company_name', 'LTO_NUMBER', 'ESTABLISHMENT_STATUS', 'ADDRESS', 'LTO_VALIDITY', 'PRODUCT_NAME', 'BRAND_NAME', 'ACCOUNTCODE'],
  canary: { found: 'NESTLE PHILIPPINES, INC.', not_found: 'Kompanyang Hindi Nakalista' },
};

const API = 'https://verification.fda.gov.ph/api/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// At least one of these lists must be in the JSON, or the page is not the search answer we expect.
const KNOWN_CATEGORIES = ['lto_food', 'lto_drugs', 'lto_cosmetics', 'lto_medicaldevice', 'lto_healthrelateddevice', 'fdafoodproducts'];
// Fields that can name a company on a record (establishment, owner, product company).
const NAME_FIELDS = ['ESTABLISHMENT_NAME', 'ESTABLISHMENT_OWNER', 'COMPANY_NAME', 'company_name', 'MANUFACTURER_NAME', 'manufacturer', 'owner'];
// Internal ids the site returns; not useful to the user.
const DROP_FIELDS = ['lto_id', 'application_id'];
const LEGAL_FORM = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'LLC', 'LLP', 'PLC', 'OPC', 'PTE', 'SDN', 'BHD', 'PT']);

/** Remove accents and punctuation, upper-case, single spaces. Non-Latin letters drop out. */
function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** Folded name without trailing legal-form words: "NESTLE PHILIPPINES INC" -> "NESTLE PHILIPPINES". */
function core(folded) {
  const t = folded.split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL_FORM.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** The comparison key for a company name. */
const matchKey = (s) => core(fold(s));

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** One search request. Returns { json, url } or { fail, url, excerpt }. Never throws. */
async function search(q) {
  const url = `${API}?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', url, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', url, excerpt: `HTTP ${res.status}` };
    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      if (/captcha|cf-chl|verify you are human|access denied/i.test(body)) return { fail: 'blocked', url, excerpt: 'bot check page' };
      return { fail: 'layout_changed', url, excerpt: 'not JSON: ' + body.slice(0, 200) };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json) || !KNOWN_CATEGORIES.some((k) => Array.isArray(json[k]))) {
      return { fail: 'layout_changed', url, excerpt: 'JSON without the known result lists: ' + body.slice(0, 200) };
    }
    return { json, url };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: timeout ? 'timeout' : 'other', url, excerpt: String((e && e.message) || e) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const raw = String(keyword ?? '').trim();
    const wanted = matchKey(raw);
    if (!wanted) return fail('other', API, 'the name has no Latin letters; this site searches Latin text');

    // The site matches the query text literally (commas and legal forms change the hits), so ask twice:
    // as typed (accents removed) and with punctuation and the legal form dropped. Matching is done here.
    const asTyped = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    // Only a second request when it asks something different (the site rate-limits; keep requests few).
    const coreText = core(fold(raw));
    const queries = fold(asTyped) === coreText ? [asTyped] : [asTyped, coreText].filter(Boolean);

    const answers = await Promise.all(queries.map(search));
    const bad = answers.find((a) => a.fail);
    if (bad) return fail(bad.fail, bad.url, bad.excerpt);

    const seen = new Set();
    const records = [];
    const cats = new Set();
    let total = 0;
    for (const a of answers) {
      for (const [cat, list] of Object.entries(a.json)) {
        if (!Array.isArray(list)) continue;
        total += list.length;
        for (const rec of list) {
          if (!rec || typeof rec !== 'object') continue;
          const field = NAME_FIELDS.find((f) => typeof rec[f] === 'string' && matchKey(rec[f]) === wanted);
          if (!field) continue;
          const rest = Object.fromEntries(Object.entries(rec).filter(([k]) => !DROP_FIELDS.includes(k)));
          const out = { ...rest, category: cat, matched_field: field };
          const id = JSON.stringify(out);
          if (seen.has(id)) continue;
          seen.add(id);
          records.push(out);
          cats.add(cat);
        }
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: answers[0].url,
        excerpt: `Matched ${records.length} record(s) for "${wanted}" in: ${[...cats].join(', ')}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: answers[0].url,
      excerpt: `Search returned ${total} result(s) for "${raw}"; none has a company name matching "${wanted}"`.slice(0, 500),
    };
  } catch (err) {
    return fail('other', API, String((err && err.message) || err));
  }
}
