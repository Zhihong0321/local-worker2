export const meta = {
  task: 'TH-workventure.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_en', 'company_id', 'company_rating', 'jobs_count', 'url'],
  canary: { found: 'กูเกิล (ประเทศไทย) จำกัด', not_found: 'บริษัท ซีแซดเอ็กซ์ควิกซ์ จำกัด' },
};

// WorkVenture's own company search: the JSON endpoint the public site calls from the browser.
// It matches the query as a substring of the company name and returns at most 15 results, with no paging.
const SEARCH_URL = 'https://api2.workventure.com/companies/search';
const SITE = 'https://www.workventure.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const RESULT_CAP = 15;

// Drops the legal form (English and Thai) and punctuation, so "Google Thailand Co., Ltd." and
// "บริษัท กูเกิล ประเทศไทย จำกัด" can be compared with the site's names.
function core(name) {
  const t = String(name || '').normalize('NFC').toLowerCase()
    .replace(/\(\s*มหาชน\s*\)|มหาชน|บริษัท|จำกัด|public company limited|company limited|sdn\.?\s*bhd\.?|co\.?\s*,?\s*ltd\.?|\bbhd\b|\bpcl\b|\bplc\b|\blimited\b|\bltd\b|\bllc\b|\binc\b|\bcorp\b|\bcorporation\b|\bco\b/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function norm(name) {
  return core(name).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim().replace(/\s+/g, ' ');
  const want = norm(input);
  // One request only, on the first word of the name: the site's substring match on "กูเกิล (ประเทศไทย)"
  // needs "กูเกิล", not "กูเกิล ประเทศไทย". Matching is then done on the full normalised name.
  const query = (core(input) || input).split(' ')[0];
  const searchUrl = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
  const fail = (status, reason, excerpt) => ({ status, reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 500) });

  try {
    if (!want || !query) return fail('couldnt_check', 'other', 'no usable company name in the input');

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/vnd.wvapi.v1+json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', `HTTP ${res.status}`);

    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || !Array.isArray(body.data)) {
      if (/captcha|access denied|cf-chl|just a moment/i.test(text.slice(0, 3000))) return fail('couldnt_check', 'blocked', 'bot check page');
      return fail('couldnt_check', 'layout_changed', text.slice(0, 300));
    }

    const records = [];
    const others = [];
    for (const item of body.data) {
      const a = (item && item.attributes) || {};
      if (norm(a.name) === want || norm(a.name_en) === want) {
        records.push({
          name: a.name || '',
          name_en: a.name_en || '',
          company_id: item.id || '',
          company_rating: a.company_rating ?? null,
          jobs_count: a.jobs_count ?? null,
          url: a.slug ? `${SITE}/company/${a.slug}/` : '',
        });
      } else {
        others.push(a.name_en || a.name || '');
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: `${records.length} match(es) for "${input}": ${records.map((r) => r.name).join(' | ')}`,
      };
    }

    // A full result list with no exact name may have cut off the real match: that is not a clean "no".
    if (body.data.length >= RESULT_CAP) {
      return fail('couldnt_check', 'other', `"${query}" hit the site's ${RESULT_CAP}-result limit and none matched "${input}" exactly; the site cannot be searched further`);
    }

    // The site answered normally; no listed company has the same normalised name.
    const near = others.length ? `; similar names, not the same company: ${others.slice(0, 5).join(' | ')}` : '';
    return fail('not_found', '', `0 matches for "${input}" (search "${query}" returned ${body.data.length} result(s))${near}`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', String((err && err.message) || err));
  }
}
