export const meta = {
  task: 'GB-s1jobs.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'open_vacancies', 'profile_url', 'jobs_url'],
  canary: { found: 'DPD GROUP UK LTD', not_found: 'Xqzvbn Unlisted Holdings Ltd' },
};

const BASE = 'https://www.s1jobs.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'cic', 'inc']);

function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparable form of a company name: case, punctuation, accents and the legal form (Ltd, Limited, LLP, PLC...) ignored. */
function normalizeName(str) {
  const words = decode(str)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** A listed name may carry a trading name ("Dechra Ltd t/a DPM"); each part is a key. */
function keysOf(name) {
  return decode(name)
    .split(/\s+t\/a\s+|\s+trading as\s+/i)
    .map(normalizeName)
    .filter(Boolean);
}

function parseItems(html) {
  return html.split('class="profileItem"').slice(1).map((part) => {
    const h3 = (part.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '';
    const a = h3.match(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) return null;
    const name = decode(a[2]);
    const hrefs = [decode(a[1])];
    const jobsLink = part.match(/href="(\/jobs\/[^"]*)"/i);
    if (jobsLink) hrefs.push(decode(jobsLink[1]));
    const profile = hrefs.find((h) => h.startsWith('/companies/'));
    const jobs = hrefs.find((h) => h.startsWith('/jobs/'));
    const vac = (part.match(/(\d[\d,]*)\s+Vacanc(?:y|ies)/i) || [])[1];
    return {
      name,
      open_vacancies: vac ? Number(vac.replace(/,/g, '')) : 0,
      profile_url: profile ? new URL(profile, BASE).href : '',
      jobs_url: jobs ? new URL(jobs, BASE).href : '',
    };
  }).filter(Boolean);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = decode(String(keyword || ''));
    const letter = kw.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toLowerCase();
    const url = `${BASE}/companies/company-directory/${letter}`;

    if (!/^[a-z]$/.test(letter)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: url,
        excerpt: 'the s1jobs company directory is listed A-Z only; this name does not start with a letter' };
    }

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url,
        excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const header = html.match(/Profiles under\s*<span>\s*([^<]*?)\s*<\/span>/i);
    if (!header || header[1].toLowerCase() !== letter) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: html.slice(0, 300) };
    }

    const items = parseItems(html);
    const kwKeys = keysOf(kw);
    const matches = kwKeys.length ? items.filter((it) => keysOf(it.name).some((k) => kwKeys.includes(k))) : [];

    if (!matches.length) {
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `No entry matching "${kw}" among the ${items.length} companies listed under "${letter.toUpperCase()}" on the s1jobs company directory`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({
        name: m.name,
        open_vacancies: m.open_vacancies,
        profile_url: m.profile_url,
        jobs_url: m.jobs_url,
      })),
      source_url: url,
      excerpt: matches.map((m) => `${m.name} (${m.open_vacancies} open vacancies)`).join('; ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `${BASE}/companies/company-directory`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
