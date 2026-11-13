export const meta = { task: 'ID-dealls.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'dealls_id', 'slug', 'profile_url', 'sector', 'city', 'country', 'verified', 'verification_status', 'job_count'],
  canary: { found: 'Telkom Indonesia', not_found: 'PT Usaha Fiktif Nusantara Bersama' } };

// Dealls' public company list (the one the /karir page loads). The search is token based and needs no login.
const API = 'https://api.sejutacita.id/v1/explore-job/company';
const SITE = 'https://dealls.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;   // the API refuses limit above 20
const MAX_PAGES = 2;    // 2 x 25 s stays under the 60 s limit
const LEGAL = new Set(['pt', 'tbk', 'persero', 'cv', 'ud', 'perum', 'perseroan', 'terbatas']);

/** lowercase, accents and punctuation removed, legal-form words removed */
function core(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');
}

/** the ways one name can be written: without the (alias) part, the alias alone, and the full name */
function nameForms(s) {
  const text = String(s || '');
  const alias = (text.match(/\(([^)]*)\)/) || [])[1] || '';
  return [core(text.replace(/\([^)]*\)/g, ' ')), core(alias), core(text)].filter(Boolean);
}

function fail(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

function toRecord(d) {
  return {
    name: d.name ?? '',
    dealls_id: d.id ?? '',
    slug: d.slug ?? '',
    profile_url: d.slug ? `${SITE}/karir/${d.slug}` : '',
    sector: d.sector ?? '',
    city: d.city?.name ?? '',
    country: d.country?.name ?? '',
    verified: d.verified ?? null,
    verification_status: d.verificationStatus ?? '',
    job_count: d.jobCount ?? null,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows aborts (exit 127) if the runner calls process.exit() while the keep-alive socket of the
  // last fetch is still closing. A short pause lets the socket settle before the answer is handed back.
  await new Promise((r) => setTimeout(r, 500));
  return answer;
}

async function lookupOnce(keyword) {
  let source_url = `${SITE}/karir`;
  try {
    const text = String(keyword ?? '').trim();
    const term = core(text.replace(/\([^)]*\)/g, ' ')) || core(text);
    if (!term) return fail('other', 'no company name in the keyword', source_url);

    const wanted = new Set(nameForms(text));
    const hits = [];
    let scanned = 0;
    let total = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      source_url = `${API}?limit=${PAGE_SIZE}&page=${page}&sortParam=mostRelevant&prioritizeBestCompany=true&deleted=false&search=${encodeURIComponent(term)}`;
      const res = await fetch(source_url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': `${SITE}/` },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`, source_url);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`, source_url);

      const body = await res.text();
      let json;
      try { json = JSON.parse(body); } catch { return fail('layout_changed', body.slice(0, 300), source_url); }
      const docs = json?.data?.docs;
      if (!Array.isArray(docs) || typeof json?.data?.totalDocs !== 'number') {
        return fail('layout_changed', body.slice(0, 300), source_url);
      }

      total = json.data.totalDocs;
      scanned += docs.length;
      for (const d of docs) {
        if (nameForms(d.name).some((f) => wanted.has(f))) hits.push(d);
      }
      if (hits.length || docs.length < PAGE_SIZE || scanned >= total) break;
    }

    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits.map(toRecord),
        source_url,
        excerpt: hits.map((d) => `${d.name} | ${d.sector ?? ''} | ${d.city?.name ?? ''} | verified=${d.verified}`).join(' ; ').slice(0, 500),
      };
    }

    if (scanned >= total) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: `${total} result(s) for "${term}", none with this name`,
      };
    }

    // The search has more results than were read and the exact name was not among them: do not call it not_found.
    return fail('other', `${total} result(s) for "${term}"; only the first ${scanned} were read, no exact name match`, source_url);
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', 'no answer within 25 s', source_url);
    return fail('other', String(err?.message || err).slice(0, 300), source_url);
  }
}
