export const meta = {
  task: 'NZ-seek.co.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'jobs_listed', 'keyword_results', 'profile_url'],
  canary: { found: 'Datacom', not_found: 'Pūkeatua Kōtuku Limited' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://nz.seek.com';
const LEGAL = new Set(['LIMITED', 'LTD', 'INCORPORATED', 'INC', 'LLC', 'LP', 'PTY', 'PTE']);

/** Drop trailing legal-form words ("Limited", "Ltd", ...) and punctuation. */
function stripLegal(name) {
  const tokens = String(name || '').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1].toUpperCase())) tokens.pop();
  return tokens;
}

/** Lower-case, accents folded (macrons too), letters and digits only. */
function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x2060;|⁠/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const tokens = stripLegal(keyword).map((t) => fold(t)).filter(Boolean);
  const target = tokens.join('');
  if (!target) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
  }
  // The site serves an employer's job list at /<Name>-jobs, e.g. /Datacom-jobs.
  const slug = tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join('-');
  const url = `${BASE}/${slug}-jobs`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-NZ,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const isNoResults = html.includes('No matching search results');
    const isJobsPage = /listed in New Zealand|jobs in New Zealand/i.test(html);

    if (!isNoResults && !isJobsPage) {
      if (/captcha|Just a moment|challenge-platform|verify you are human|Access denied/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: decode(html).slice(0, 200) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: decode(html).slice(0, 200) };
    }

    if (isNoResults) {
      return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `No matching search results for "${keyword}"` };
    }

    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const total = h1 ? parseInt(decode(h1[1]).replace(/,/g, '').match(/^\d+/)?.[0] || '', 10) : NaN;

    // Employer-level sentence: "207 Datacom jobs (65 at Datacom) listed in New Zealand."
    let siteName = '';
    let jobsListed = 0;
    let sentence = '';
    const phraseRe = /\((\d[\d,]*) at ([^()<>]+?)\) listed in New Zealand/g;
    for (const m of html.matchAll(phraseRe)) {
      const name = decode(m[2]);
      if (fold(name) === target) {
        siteName = name;
        jobsListed = parseInt(m[1].replace(/,/g, ''), 10);
        sentence = decode(m[0]);
        break;
      }
    }

    // Fallback: advertiser links on the job cards, e.g. <a data-automation="jobCompany">Datacom</a>.
    if (!siteName) {
      let cardHits = 0;
      for (const m of html.matchAll(/<a[^>]*data-automation="jobCompany"[^>]*>([\s\S]*?)<\/a>/g)) {
        const name = decode(m[1]);
        if (fold(name) === target) {
          siteName = siteName || name;
          cardHits += 1;
        }
      }
      if (cardHits > 0) {
        jobsListed = cardHits;
        sentence = `${cardHits} job card(s) on the first results page posted by ${siteName}`;
      }
    }

    if (!siteName) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `${Number.isFinite(total) ? total : 'some'} job(s) match "${keyword}", none posted by an employer with this name`,
      };
    }

    // Company profile link (needs the numeric id, so only taken when the page shows it for this name).
    const slugLower = tokens.map((t) => t.toLowerCase()).join('-');
    const profileMatch = html.match(new RegExp(`href="(/companies/${slugLower}-\\d+)`, 'i'));
    const profileUrl = profileMatch ? `${BASE}${profileMatch[1]}` : '';

    return {
      status: 'found',
      reason: '',
      records: [{
        name: siteName,
        jobs_listed: jobsListed,
        keyword_results: Number.isFinite(total) ? total : null,
        profile_url: profileUrl,
      }],
      source_url: url,
      excerpt: sentence.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
