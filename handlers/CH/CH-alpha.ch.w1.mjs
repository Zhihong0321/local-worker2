export const meta = {
  task: 'CH-alpha.ch',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'open_postings', 'latest_posting', 'locations', 'job_titles', 'job_url'],
  canary: { found: 'Swisscom Directories AG', not_found: 'Gasthaus zum Nichtexistierenden Hirschen GmbH' },
};

const SEARCH = 'https://www.alpha.ch/jobs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 10;          // read at most 10 result pages (100 postings)
const BUDGET_MS = 40000;       // stop reading more pages after 40 s, well under the 60 s limit
const BATCH = 3;               // pages fetched at a time
const LEGAL = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'kg', 'se', 'co', 'and', 'limited', 'corp', 'plc']);

/** lower case, no accents, no punctuation; "&" and "and" are the same word */
function fold(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** normalised company name without the legal form (AG, GmbH, SA, Sàrl, Ltd, "AG & Co. KG" ...) */
function core(s) {
  const toks = fold(s).split(' ').filter(Boolean);
  if (toks.length >= 2 && toks[toks.length - 2] === 's' && toks[toks.length - 1] === 'a') toks.splice(-2);
  while (toks.length > 1 && LEGAL.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

/** the keyword with trailing legal-form words removed, so the site search is not diluted by "AG" or "GmbH" */
function searchTerm(keyword) {
  const words = keyword.trim().split(/\s+/);
  while (words.length > 1 && LEGAL.has(fold(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

function pageUrl(term, page) {
  return `${SEARCH}?q=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Fetch one result page and read the job list the page embeds. Returns { jobs, total, pageSize } or { fail }. */
async function readPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.7' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: fail(timeout ? 'timeout' : 'other', url, String(e?.message || e)) };
  }
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('http_error', url, `HTTP ${res.status}`) };

  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    if (/captcha|cf-chl|challenge-platform|recaptcha|access denied/i.test(html.slice(0, 20000))) {
      return { fail: fail('blocked', url, 'bot check or captcha page') };
    }
    return { fail: fail('layout_changed', url, html.slice(0, 200)) };
  }
  let data;
  try { data = JSON.parse(m[1]); } catch { return { fail: fail('layout_changed', url, 'embedded data is not JSON') }; }
  const pp = data?.props?.pageProps || {};
  const s = pp.jobsSSR;
  if (!s || typeof s.resultCount !== 'number' || !Array.isArray(s.jobs)) {
    return { fail: fail('layout_changed', url, 'no jobsSSR list in the page') };
  }
  if (pp.errorFindingJobSSR || s.errorText) {
    return { fail: fail('other', url, `site reported an error: ${s.errorText || 'errorFindingJobSSR'}`) };
  }
  return { jobs: s.jobs, total: s.resultCount, pageSize: s.pageSize || 10 };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const name = String(keyword || '').trim();
    if (!name) return fail('other', SEARCH, 'empty company name');

    const term = searchTerm(name);
    const firstUrl = pageUrl(term, 1);

    const first = await readPage(firstUrl);
    if (first.fail) return first.fail;

    const { total, pageSize } = first;
    const pages = Math.min(Math.ceil(total / pageSize), MAX_PAGES);
    const jobs = [...first.jobs];
    let readPages = 1;
    let stoppedEarly = '';

    for (let p = 2; p <= pages; p += BATCH) {
      if (Date.now() - started > BUDGET_MS) { stoppedEarly = `read ${readPages} of ${pages} pages before the time limit`; break; }
      const batch = [];
      for (let q = p; q < p + BATCH && q <= pages; q++) batch.push(readPage(pageUrl(term, q)));
      const got = await Promise.all(batch);
      for (const g of got) {
        if (g.fail) return g.fail;
        jobs.push(...g.jobs);
        readPages++;
      }
    }
    const allRead = readPages >= Math.ceil(total / pageSize) || total === 0;

    // Match the company, not similar words: the employer name on each posting must have the same normalised core.
    const want = core(name);
    const seen = new Set();
    const matched = jobs.filter((j) => {
      if (!want || core(j.companyName) !== want || seen.has(j.jobId)) return false;
      seen.add(j.jobId);
      return true;
    });

    if (matched.length === 0) {
      if (!allRead && total > 0) {
        const why = stoppedEarly || `the search has ${total} postings and only the first ${MAX_PAGES * pageSize} are read`;
        return fail(stoppedEarly ? 'timeout' : 'other', firstUrl, `no posting names this company among the postings read; ${why}`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `0 of ${total} postings on the search "${term}" name this company`,
      };
    }

    // One record per distinct employer name as the site writes it.
    const byName = new Map();
    for (const j of matched) {
      const key = j.companyName;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(j);
    }
    const records = [...byName.entries()].map(([companyName, list]) => {
      const dates = list.map((j) => j.datePosted).filter(Boolean).sort();
      const locs = [...new Set(list.map((j) => j.location).filter(Boolean))];
      return {
        name: companyName,
        open_postings: list.length,
        latest_posting: dates.length ? dates[dates.length - 1] : '',
        locations: locs.slice(0, 10),
        job_titles: list.map((j) => j.title).filter(Boolean).slice(0, 10),
        job_url: list[0].jobId ? `https://www.alpha.ch/job/${list[0].jobId}` : '',
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstUrl,
      excerpt: `${matched.length} posting(s) by ${records.map((r) => r.name).join(', ')}; search "${term}" has ${total} postings`,
    };
  } catch (err) {
    return fail('other', SEARCH, String(err?.message || err));
  }
}
