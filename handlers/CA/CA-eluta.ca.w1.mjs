export const meta = {
  task: 'CA-eluta.ca',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'eluta_employer_page', 'top_employer', 'job_titles'],
  canary: { found: 'Labatt Breweries of Canada', not_found: 'Entreprise Fantôme Zéphyr Inc' },
};

const BASE = 'https://www.eluta.ca';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;           // result pages read at most for one name
const PAGE_BUDGET_MS = 25000;  // no further result page is requested after this much time
const FETCH_TIMEOUT_MS = 25000;
// Trailing legal-form words, dropped before comparing names and before searching (Eluta's search does not index them).
const LEGAL = new Set(['ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'lp', 'llp',
  'llc', 'ulc', 'ltee', 'lte', 'plc', 'sec', 'enc', 'cie']);

// One result = a job title, then its employer link (the employer is shown under each job).
const RESULT_RE = /class="lk-job-title"[\s\S]*?title="([^"]*)"[\s\S]*?class="employer lk-employer"[\s\S]*?onclick="window\.location\.href='([^']*)'"[\s\S]*?title="See all jobs at ([^"]*)"/g;
const TOP_RE = /class="lk-employer-review"[\s\S]*?title="Read why ([^"]*) is a top employer/g;
const NEXT_RE = /<a id="pager-next"\s+href="([^"]*)"/;

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Lower-case ASCII words of a company name, without punctuation, accents or trailing legal form. */
function words(name) {
  const w = decode(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

function parsePage(html) {
  const results = [];
  const top = new Set();
  for (const m of html.matchAll(new RegExp(RESULT_RE.source, 'g'))) {
    results.push({ job: decode(m[1]), page: new URL(decode(m[2]), BASE).href, name: decode(m[3]) });
  }
  for (const m of html.matchAll(new RegExp(TOP_RE.source, 'g'))) top.add(decode(m[1]));
  const jobs = (html.match(/class="lk-job-title"/g) || []).length;
  const next = html.match(NEXT_RE);
  return {
    results,
    top,
    jobs,
    noResults: /class="noResults"/.test(html),
    next: next ? new URL(decode(next[1]), BASE).href : null,
  };
}

function out(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const key = words(keyword).join(' ');
  if (!key) return out('couldnt_check', 'other', BASE, 'no company name given');

  const firstUrl = `${BASE}/search?q=${encodeURIComponent(key)}`;
  let url = firstUrl;
  try {
    const found = new Map(); // eluta employer page -> record
    let pages = 0;
    let truncated = false;
    let anyJobs = false;
    const similar = new Set();

    for (;;) {
      pages++;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return out('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (/<title>[^<]*(User Verification|Just a moment|Access denied|Attention Required)/i.test(html)) {
        return out('couldnt_check', 'blocked', url, (html.match(/<title>[^<]*/i) || [''])[0]);
      }
      const p = parsePage(html);
      if (p.jobs === 0 && !p.noResults) {
        return out('couldnt_check', 'layout_changed', url, html.slice(0, 300));
      }
      anyJobs = anyJobs || p.jobs > 0;

      for (const r of p.results) {
        if (words(r.name).join(' ') !== key) { similar.add(r.name); continue; }
        const g = found.get(r.page) || { name: r.name, eluta_employer_page: r.page, top_employer: p.top.has(r.name), job_titles: [], jobs_here: 0 };
        g.jobs_here += 1;
        if (r.job && g.job_titles.length < 5 && !g.job_titles.includes(r.job)) g.job_titles.push(r.job);
        found.set(r.page, g);
      }
      if (found.size) break;
      if (!p.next) break;
      if (pages >= MAX_PAGES || Date.now() - started >= PAGE_BUDGET_MS) { truncated = true; break; }
      url = p.next;
    }

    if (found.size) {
      const records = [...found.values()].map(({ jobs_here, ...rec }) => rec);
      const names = records.map((r) => `${r.name} (${found.get(r.eluta_employer_page).jobs_here} job(s) on this page)`);
      return out('found', '', url, `Eluta lists jobs from: ${names.join('; ')}`, records);
    }
    if (truncated) {
      return out('couldnt_check', 'other', url,
        `"${key}" is not among the employers on the first ${pages} result pages, and more pages exist`);
    }
    const note = similar.size ? `; similar employer names on the page: ${[...similar].slice(0, 5).join('; ')}` : '';
    if (!anyJobs) return out('not_found', '', firstUrl, `0 results for "${key}"`);
    return out('not_found', '', firstUrl,
      `${pages} result page(s) for "${key}", no job from an employer with that name${note}`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', url,
      timeout ? 'no answer within 25 s' : String(err?.message || err));
  }
}
