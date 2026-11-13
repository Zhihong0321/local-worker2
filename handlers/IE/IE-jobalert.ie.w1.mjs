export const meta = { task: 'IE-jobalert.ie', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['company_name', 'job_title', 'job_url', 'job_status', 'is_open', 'address', 'county', 'country', 'posted_at'],
  canary: { found: 'Tesco', not_found: 'Cuideachta Ghaelach Neamhaimhnithe Teoranta' } };

const BASE = 'https://www.jobalert.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 5;                 // 10 results per page, so at most 50 results are read
const NO_NEW_PAGE_AFTER_MS = 30000;  // a page fetch can take up to 25 s, so this keeps the call under 60 s
const LEGAL_PHRASES = [/\bdesignated activity company\b/g, /\bcompany limited by guarantee\b/g, /\blimited by guarantee\b/g, /\bunlimited company\b/g];
const LEGAL_WORDS = new Set(['ltd', 'limited', 'dac', 'plc', 'teoranta', 'teo', 'unlimited', 'uc', 'clg', 'llp', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company']);
const BLOCK_RE = /captcha|cf-chl|just a moment|attention required|access denied/i;

/** Normalised company name: lower case, no accents or punctuation, legal form removed from the end. */
function coreName(str) {
  let s = String(str || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  for (const re of LEGAL_PHRASES) s = s.replace(re, ' ');
  const words = s.split(' ').filter(Boolean);
  while (words.length && LEGAL_WORDS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The search results the page carries as JSON (Next.js __NEXT_DATA__), or null if the page is not that. */
function readResults(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const jobs = data?.props?.pageProps?.initialReduxState?.entities?.jobs;
  if (!jobs || !Array.isArray(jobs.data) || typeof jobs.count !== 'number') return null;
  return { count: jobs.count, items: jobs.data };
}

function record(j) {
  return {
    company_name: j.company?.name || '',
    job_title: j.title || '',
    job_url: `${BASE}/job/${j.slug || ''}`,
    job_status: j.status || '',
    is_open: j.isOpen === true,
    address: j.address?.formatted || '',
    county: j.address?.county || '',
    country: j.address?.country || '',
    posted_at: j.postedAt || '',
  };
}

function answer(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').replace(/\s+/g, ' ').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let firstUrl = `${BASE}/jobs`;
  try {
    const name = coreName(keyword);
    if (!name) return answer('couldnt_check', 'other', firstUrl, 'no company name to search for');
    firstUrl = `${BASE}/jobs?search=${encodeURIComponent(name)}`;

    const matches = [];
    let matchUrl = firstUrl;
    let checked = 0;
    let total = null;
    let outOfTime = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) { outOfTime = true; break; }
      const url = page === 0 ? firstUrl : `${firstUrl}&page=${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return answer('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return answer('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      const results = readResults(html);
      if (!results) {
        const title = (html.match(/<title>[^<]*<\/title>/) || [''])[0];
        return answer('couldnt_check', BLOCK_RE.test(html) ? 'blocked' : 'layout_changed', url, title);
      }

      total = results.count;
      const hits = results.items.filter((j) => coreName(j?.company?.name) === name);
      if (hits.length && !matches.length) matchUrl = url;
      for (const j of hits) matches.push(record(j));
      checked += results.items.length;
      if (!results.items.length || checked >= total) break;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matchUrl,
        excerpt: `${matches.length} job ad(s) listed by "${matches[0].company_name}" on JobAlert.ie (checked ${checked} of ${total} search results)`,
      };
    }
    if (total !== null && checked >= total) {
      return answer('not_found', '', firstUrl, `0 job ads by a company named "${keyword}" (checked ${checked} of ${total} search results)`);
    }
    return answer('couldnt_check', outOfTime ? 'timeout' : 'other', firstUrl,
      `no job ad by "${keyword}" in the first ${checked} of ${total} search results; not all results could be read`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer('couldnt_check', timeout ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
