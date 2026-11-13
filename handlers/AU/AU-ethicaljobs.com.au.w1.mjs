export const meta = {
  task: 'AU-ethicaljobs.com.au',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'open_jobs', 'profile_url'],
  canary: { found: 'World Vision', not_found: 'Quorbix Harbour Holdings Pty Ltd' },
};

const SITE = 'https://www.ethicaljobs.com.au';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['pty', 'ltd', 'limited', 'inc', 'incorporated', 'proprietary', 'llc']);
const GENERIC_TITLE = 'Ethical Jobs - EthicalJobs.com.au';
const EMPLOYER_SUFFIX = ' jobs on EthicalJobs.com.au - EthicalJobs.com.au';

/** Lower-case Latin words and digits only, accents removed. */
function tokens(str) {
  return (str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function stripLegalForm(list) {
  const out = list.slice();
  while (out.length && LEGAL_FORMS.has(out[out.length - 1])) out.pop();
  return out;
}

/** The comparison key: normalised words, legal form removed, no separators. */
function nameKey(str) {
  return stripLegalForm(tokens(str)).join('');
}

/**
 * Employer page addresses to try: "/jobs-at-<slug>". The site writes slugs two ways (punctuation dropped,
 * e.g. "Uniting (NSW.ACT)" -> "uniting-nswact"; or punctuation split, "NSW.ACT" -> "nsw-act"), with the legal
 * form kept or dropped, and with hyphens or without.
 */
function slugVariants(keyword) {
  const base = (keyword || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const wordLists = [
    base.replace(/[^a-z0-9\s]+/g, '').split(/\s+/).filter(Boolean),
    base.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean),
  ];
  const slugs = new Set();
  for (const words of wordLists) {
    for (const parts of [words, stripLegalForm(words)]) {
      if (!parts.length) continue;
      slugs.add(parts.join('-'));
      slugs.add(parts.join(''));
    }
  }
  return [...slugs];
}

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Read one employer address. Returns {type: 'match' | 'other_employer' | 'absent' | 'blocked' | 'layout_changed'}. */
function readPage(html, key) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decode(titleMatch ? titleMatch[1] : '').trim();
  const plain = html.replace(/<!--[\s\S]*?-->/g, '');

  if (title === GENERIC_TITLE) return { type: 'absent' };

  if (title.endsWith(EMPLOYER_SUFFIX)) {
    const name = title.slice(0, -EMPLOYER_SUFFIX.length).trim();
    const countMatch = plain.match(/We found\s+(\d+)\s+jobs at/i);
    const openJobs = countMatch ? Number(countMatch[1]) : null;
    if (nameKey(name) === key) {
      return { type: 'match', name, open_jobs: openJobs, excerpt: countMatch ? countMatch[0] : title };
    }
    return { type: 'other_employer' };
  }

  if (/cf-chl|captcha|Just a moment|Attention Required/i.test(html.slice(0, 30000))) return { type: 'blocked' };
  return { type: 'layout_changed', excerpt: title || html.slice(0, 200) };
}

async function checkOne(url, key) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { url, error: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { url, error: 'http_error', excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    const page = readPage(html, key);
    if (page.type === 'match') return { url, ...page };
    if (page.type === 'absent' || page.type === 'other_employer') return { url, type: page.type };
    return { url, error: page.type, excerpt: page.excerpt || '' };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, error: timedOut ? 'timeout' : 'other', excerpt: String((err && err.message) || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = typeof keyword === 'string' ? keyword.trim() : '';
  try {
    const key = nameKey(kw);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE,
        excerpt: 'no Latin letters in the name, so no EthicalJobs address can be built' };
    }

    const urls = slugVariants(kw).map((slug) => `${SITE}/jobs-at-${slug}`);
    const results = await Promise.all(urls.map((u) => checkOne(u, key)));

    const matches = results.filter((r) => r.type === 'match');
    if (matches.length) {
      const seen = new Set();
      const records = [];
      for (const m of matches) {
        if (seen.has(m.url)) continue;
        seen.add(m.url);
        records.push({ name: m.name, open_jobs: m.open_jobs, profile_url: m.url });
      }
      return { status: 'found', reason: '', records, source_url: records[0].profile_url, excerpt: matches[0].excerpt };
    }

    const errors = results.filter((r) => r.error);
    if (errors.length) {
      // A refused or unreadable address means we do not know: never call that not_found.
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      const worst = order.find((o) => errors.some((e) => e.error === o)) || 'other';
      const e = errors.find((x) => x.error === worst);
      return { status: 'couldnt_check', reason: worst, records: [], source_url: e.url, excerpt: e.excerpt };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: urls[0],
      excerpt: `no EthicalJobs employer page matches "${kw}" (tried ${urls.length} addresses, all answered normally)`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE,
      excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
