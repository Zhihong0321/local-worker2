export const meta = { task: 'IN-workindia.in', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'job_count', 'cities', 'job_titles', 'url'],
  canary: { found: 'Amazon', not_found: 'Mahalaxmi Gharelu Udyog Sanstha Pvt Ltd' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.workindia.in';
const LEGAL = ['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'corp', 'corporation', 'llc', 'opc', 'co', 'company'];

// Latin letters and digits only, lower case, accents removed.
function words(str) {
  return (str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// The name without trailing legal-form words ("ACME PVT. LTD." -> "acme").
function coreWords(str) {
  const w = words(str);
  while (w.length > 1 && LEGAL.includes(w[w.length - 1])) w.pop();
  return w;
}

function slugOf(list) {
  return list.join('-');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const exact = words(keyword);
    const core = coreWords(keyword);
    if (exact.length === 0) {
      return fail('other', BASE, 'the name has no Latin letters; WorkIndia company pages are addressed by Latin names');
    }
    // Company pages are addressed by name slug; try the name as typed, then without the legal form.
    const slugs = [...new Set([slugOf(exact), slugOf(core)])].filter(Boolean);
    const want = core.join(' ');
    const started = Date.now();
    let lastUrl = '';
    let lastExcerpt = '';

    for (let i = 0; i < slugs.length; i++) {
      if (i > 0 && Date.now() - started > 30000) break; // keep the whole call under 60 s
      const url = `${BASE}/company/${slugs[i]}-job-openings/`;
      lastUrl = url;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IN,en;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
      const html = await res.text();

      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (/captcha|access denied|verify you are human/i.test(html.slice(0, 20000))) return fail('blocked', url, 'bot check page');
      if (res.status === 404) {
        lastExcerpt = '404 Page Not Found';
        if (!/404 Page Not Found/i.test(html)) return fail('layout_changed', url, html.slice(0, 300));
        continue;
      }
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      // The job list is embedded in the page as JSON.
      const marker = 'window.__ROUTE_DATA__=';
      const at = html.indexOf(marker);
      if (at < 0) return fail('layout_changed', url, html.slice(0, 300));
      const end = html.indexOf('</script>', at);
      let data;
      try {
        data = JSON.parse(html.slice(at + marker.length, end).trim().replace(/;$/, ''));
      } catch (e) {
        return fail('layout_changed', url, 'job list JSON could not be read');
      }
      const jobs = Array.isArray(data?.data) ? data.data : null;
      if (!jobs) return fail('layout_changed', url, 'no job list in the page');

      const matched = jobs.filter((j) => coreWords(j.branch_company_name || '').join(' ') === want);
      lastExcerpt = `${jobs.length} job(s) on the page, ${matched.length} for "${want}"`;
      if (matched.length === 0) continue;

      const names = [...new Set(matched.map((j) => j.branch_company_name))];
      const cities = [...new Set(matched.map((j) => j.branch_location_city_name).filter(Boolean))];
      const titles = [...new Set(matched.map((j) => j.profile_job_title).filter(Boolean))].slice(0, 20);
      const more = data.next ? ' (more pages exist on the site)' : '';
      return {
        status: 'found',
        reason: '',
        records: [{
          name: names.join(' / '),
          job_count: typeof data.count === 'number' ? data.count : matched.length,
          cities,
          job_titles: titles,
          url,
        }],
        source_url: url,
        excerpt: `${matched.length} open job(s) listed under "${names.join(' / ')}"${more}`.slice(0, 300),
      };
    }

    return { status: 'not_found', reason: '', records: [], source_url: lastUrl, excerpt: lastExcerpt || 'no company page' };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, `${BASE}/company/`, String(err?.message || err));
  }
}
