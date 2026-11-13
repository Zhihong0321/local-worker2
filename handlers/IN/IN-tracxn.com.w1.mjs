export const meta = { task: 'IN-tracxn.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'entity_id', 'status_at_registrar', 'mapped_entity_type', 'incorporation_date', 'listing_status', 'brands', 'detail_url'],
  canary: { found: 'INFOSYS LIMITED', not_found: 'श्रीगणेश अज्ञात व्यापार प्राइवेट लिमिटेड' } };

// Tracxn's own legal-entity search (the same POST the search page makes in the browser), filtered to India.
// Country id copied from the site's page data (initialCountry: India, isoCode IN).
const INDIA_ID = '57ada2abe4b0e0fbead7d6da';
const API = 'https://tracxn.com/utils/discovery/legal-entities/search';
const PAGE_URL = 'https://tracxn.com/search/legal-entities';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words ignored when comparing names ("Pvt. Ltd." = "Private Limited").
const LEGAL_FORMS = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'PUBLIC', 'PLC', 'INC', 'OPC', 'CO', 'COMPANY']);

/** Upper case, '&' as AND, punctuation removed, single spaces. */
function normalize(s) {
  return String(s || '').normalize('NFKC').toUpperCase().replace(/&/g, ' AND ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

/** Normalised name without legal-form words. */
function core(s) {
  return normalize(s).split(' ').filter((t) => t && !LEGAL_FORMS.has(t)).join(' ');
}

function isoDate(d) {
  if (!d || !d.year || !d.month || !d.day) return '';
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let out;
  try {
    out = await search(keyword);
  } catch (err) {
    out = fail('other', PAGE_URL, String(err?.message || err));
  }
  // Node 24 on Windows aborts ("UV_HANDLE_CLOSING") when the runner exits right after a fetch, before the
  // socket has closed. A short settle avoids that; it costs one second and changes nothing in the answer.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return out;
}

async function search(keyword) {
  const name = String(keyword || '').trim();
  const source_url = `${PAGE_URL}?q=${encodeURIComponent(name)}&c=india`;
  if (!name) return fail('other', PAGE_URL, 'empty company name');
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Referer': source_url,
      },
      body: JSON.stringify({ filter: { countryId: [INDIA_ID] }, query: { keyword: [name] } }),
    });
    const text = await res.text();

    if (res.status === 403 || res.status === 429) {
      return fail('blocked', source_url, `HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    if (!res.ok) return fail('http_error', source_url, `HTTP ${res.status}`);

    let body;
    try { body = JSON.parse(text); } catch (e) {
      if (/captcha|access denied|verify you are human/i.test(text)) return fail('blocked', source_url, 'bot or captcha page');
      return fail('layout_changed', source_url, text.slice(0, 300));
    }
    if (!body || !Array.isArray(body.result) || typeof body.total_count !== 'number') {
      return fail('layout_changed', source_url, JSON.stringify(body).slice(0, 300));
    }

    // The site's search is fuzzy (it matches single words), so keep only entries whose name really is this company.
    const wanted = normalize(name);
    const wantedCore = core(name);
    const matches = body.result.filter((r) => {
      const got = normalize(r.name);
      return got === wanted || (wantedCore !== '' && core(r.name) === wantedCore);
    });

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url,
        excerpt: `Tracxn search: ${body.total_count} hit(s) for "${name}", first ${body.result.length} checked, none with this name`,
      };
    }

    const records = matches.map((r) => ({
      name: r.name,
      entity_id: r.entityId || '',
      status_at_registrar: r.statusAtRegistrar || '',
      mapped_entity_type: r.mappedEntityType || '',
      incorporation_date: isoDate(r.incorporationDate),
      listing_status: r.status || '',
      brands: (r.companies || []).map((c) => c.name).filter(Boolean),
      detail_url: r.slug && r.slugId ? `https://tracxn.com/d/legal-entities/${r.slug}/${r.slugId}` : '',
    }));
    return {
      status: 'found', reason: '', records, source_url,
      excerpt: `${records.length} matching legal entit${records.length === 1 ? 'y' : 'ies'}: ${records.map((r) => r.name).join('; ')}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', source_url, String(err?.message || err));
  }
}
