export const meta = {
  task: 'IN-ficci.in',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership_category'],
  canary: { found: 'Tata Steel Limited', not_found: 'नकली कंपनी लिमिटेड' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The four FICCI member directories. Each one has the same search box: ?search=<name>.
const CATEGORIES = [
  ['corporate_member', 'Corporate Member'],
  ['associate_member', 'Associate Member'],
  ['chambers_member', 'Chambers/Association'],
  ['startup_member', 'Startup Member'],
];

const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'pte', 'plc']);

/** Comparison key: lower case, "&" = "and", punctuation and legal-form words removed. Keeps Devanagari matras (\p{M}). */
function core(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w && !LEGAL.has(w))
    .join('');
}

/** Term sent to the site: the name as typed, minus trailing legal-form words (the site lists "Ltd" as "Limited" etc.). */
function searchTerm(name) {
  const words = name.replace(/[.,]/g, ' ').split(/\s+/).filter((w) => w && !LEGAL.has(w.toLowerCase()));
  return words.length ? words.join(' ') : name;
}

function cleanText(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMembers(html) {
  const names = [];
  const re = /<p class="width-area">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    const n = cleanText(m[1]);
    if (n) names.push(n);
  }
  return names;
}

/** One directory search. Never throws: returns { url, label, names, matches } or { url, label, problem: { reason, excerpt } }. */
async function checkCategory(slug, label, term, keyNorm) {
  const url = `https://ficci.in/${slug}?search=${encodeURIComponent(term)}`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { url, label, problem: { reason: 'blocked', excerpt: `HTTP ${res.status} on ${slug}` } };
    }
    if (!res.ok) {
      return { url, label, problem: { reason: 'http_error', excerpt: `HTTP ${res.status} on ${slug}` } };
    }
    const html = await res.text();
    if (!html.includes('members-name-city')) {
      if (/captcha|cf-chl|just a moment/i.test(html)) {
        return { url, label, problem: { reason: 'blocked', excerpt: `bot check on ${slug}` } };
      }
      return { url, label, problem: { reason: 'layout_changed', excerpt: `member list not found on ${slug}: ${cleanText(html).slice(0, 200)}` } };
    }
    const names = parseMembers(html);
    const matches = names.filter((n) => core(n) === keyNorm);
    return { url, label, names, matches };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, label, problem: { reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) } };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const fallbackUrl = `https://ficci.in/corporate_member?search=${encodeURIComponent(name)}`;
  try {
    const keyNorm = core(name);
    if (!keyNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: fallbackUrl, excerpt: 'no usable letters in the company name' };
    }
    const term = searchTerm(name);
    const results = await Promise.all(CATEGORIES.map(([slug, label]) => checkCategory(slug, label, term, keyNorm)));
    const checked = results.map((r) => r.label).join(', ');

    // Matches in any directory: found.
    const records = [];
    const seen = new Set();
    for (const r of results) {
      for (const m of r.matches || []) {
        const key = `${r.label}|${m}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({ name: m, membership_category: r.label });
      }
    }
    if (records.length) {
      const hit = results.find((r) => r.matches && r.matches.length);
      return {
        status: 'found',
        reason: '',
        records,
        source_url: hit.url,
        excerpt: `Listed on the FICCI member directory: ${records.map((r) => `${r.name} (${r.membership_category})`).join('; ')}`.slice(0, 500),
      };
    }

    // No match, but a directory could not be read: we cannot say the company is absent.
    const problems = results.filter((r) => r.problem);
    if (problems.length) {
      const order = ['blocked', 'layout_changed', 'http_error', 'timeout', 'other'];
      problems.sort((a, b) => order.indexOf(a.problem.reason) - order.indexOf(b.problem.reason));
      const worst = problems[0];
      return {
        status: 'couldnt_check',
        reason: worst.problem.reason,
        records: [],
        source_url: worst.url,
        excerpt: `${worst.problem.excerpt} (checked: ${checked})`.slice(0, 500),
      };
    }

    // Every directory answered normally and none lists the company.
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: fallbackUrl,
      excerpt: `No match for "${term}" in the FICCI member directories (${checked}); the searches returned ${results.reduce((n, r) => n + (r.names || []).length, 0)} entries, none with the same name.`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: fallbackUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
