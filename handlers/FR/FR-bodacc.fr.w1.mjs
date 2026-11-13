export const meta = {
  task: 'FR-bodacc.fr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'city', 'court', 'published', 'notice_family', 'notice_type', 'url'],
  canary: { found: 'DANONE', not_found: 'Les Ateliers Imaginaires Introuvables SARL' },
};

// The open-data API behind bodacc.fr's own search (site: /pages/api-bodacc/, anonymous access, no key).
const API = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};
const LEGAL = new Set(['SA', 'SAS', 'SASU', 'SARL', 'SARLU', 'EURL', 'SNC', 'SCI', 'SCA', 'SCS', 'SELARL', 'SELAS', 'SELAFA',
  'SELURL', 'SEL', 'SE', 'SCOP', 'SCOPS', 'SCM', 'SCP', 'SCEA', 'GAEC', 'EARL', 'EI', 'EIRL', 'GIE', 'SASP', 'SAEM',
  'SCIC', 'SEM', 'SPL', 'SICAV', 'SC', 'SEP', 'LTD']);
const LIMIT = 100;
const SELECT = 'commercant,registre,ville,tribunal,dateparution,familleavis_lib,typeavis_lib,url_complete';

/** Upper-case ASCII words: accents, case and punctuation removed. */
function words(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** The name without a trailing legal form, as ASCII words. */
function core(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** The name as typed, minus a trailing legal form (punctuation and accents kept). */
function rawCore(s) {
  const t = String(s || '').trim().split(/\s+/).filter(Boolean);
  while (t.length > 1 && LEGAL.has(words(t[t.length - 1]).join(''))) t.pop();
  return t.join(' ').replace(/[.,;:]+$/, '').trim();
}

/** Same company: the whole register name, or the part before the first comma ("NAME SARL, NAME"). */
function sameCompany(recordName, want) {
  const name = String(recordName || '');
  return core(name) === want || core(name.split(',')[0]) === want;
}

function toRecord(r) {
  return {
    name: r.commercant || '',
    registration_number: (Array.isArray(r.registre) && r.registre[0]) || '',
    city: r.ville || '',
    court: r.tribunal || '',
    published: r.dateparution || '',
    notice_family: r.familleavis_lib || '',
    notice_type: r.typeavis_lib || '',
    url: r.url_complete || '',
  };
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if ([401, 403, 429].includes(res.status)) return { fail: 'blocked', detail: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status}` };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (json && typeof json.total_count === 'number' && Array.isArray(json.results)) return { json };
  if (/captcha|access denied|challenge-platform/i.test(text.slice(0, 5000))) return { fail: 'blocked', detail: 'bot check page' };
  return { fail: 'layout_changed', detail: text.slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await check(keyword);
  // Give the HTTP connection a moment to close: the runner calls process.exit right after this returns, and on
  // Node 24 / Windows an immediate exit after a fetch aborts with an assertion (exit 127) even though the answer printed.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function check(keyword) {
  let url = '';
  try {
    const name = rawCore(keyword);
    const want = core(keyword);
    if (!name || !want) return out('couldnt_check', 'other', [], API, 'the name has no letters or digits to search for');

    // 1) Exact register name first (this search is case- and punctuation-sensitive).
    const exactWhere = `commercant="${name.replace(/["\\]/g, '')}"`;
    url = `${API}?where=${encodeURIComponent(exactWhere)}&order_by=${encodeURIComponent('dateparution desc')}` +
      `&limit=${LIMIT}&select=${encodeURIComponent(SELECT)}`;
    let got = await getJson(url);
    if (got.fail) return out('couldnt_check', got.fail, [], url, got.detail);
    let total = got.json.total_count;
    let hits = got.json.results.filter((r) => sameCompany(r.commercant, want));

    // 2) No exact entry: word search, then compare normalised names (case, punctuation, legal form).
    if (total === 0) {
      const searchWhere = `search(commercant,"${words(name).join(' ')}")`;
      url = `${API}?where=${encodeURIComponent(searchWhere)}&order_by=${encodeURIComponent('dateparution desc')}` +
        `&limit=${LIMIT}&select=${encodeURIComponent(SELECT)}`;
      got = await getJson(url);
      if (got.fail) return out('couldnt_check', got.fail, [], url, got.detail);
      total = got.json.total_count;
      hits = got.json.results.filter((r) => sameCompany(r.commercant, want));
    }

    if (hits.length === 0) {
      return out('not_found', '', [], url,
        `0 BODACC announcements for "${name}" (${total} search hit(s), none with this company name)`);
    }
    const records = hits.map(toRecord);
    return out('found', '', records, url,
      `${records.length} announcement(s) for ${records[0].name}, newest published ${records[0].published}; ` +
      `the query matched ${total} entr${total === 1 ? 'y' : 'ies'}, the newest ${LIMIT} are kept`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], url || API, String((err && err.message) || err));
  }
}
