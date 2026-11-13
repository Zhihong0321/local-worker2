export const meta = {
  task: 'IN-shine.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'openings', 'url'],
  canary: { found: 'Tech Mahindra Ltd', not_found: 'टेस्ट कंपनी प्राइवेट लिमिटेड' },
};

const BASE = 'https://www.shine.com/job-search/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words that do not change which company is meant.
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'opc', 'inc', 'incorporated', 'plc', 'llc', 'co', 'company', 'corp', 'corporation', 'sdn', 'bhd']);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

// Words of a name, lower-cased. Keeps letters and marks of any script (Devanagari vowel signs are marks).
function words(str) {
  return decodeEntities(str).toLowerCase().replace(/&/g, ' and ').split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

// Company identity: words without legal form, joined. "TECH MAHINDRA LIMITED" and "Tech Mahindra Ltd" give the same key.
function coreWords(str) {
  return words(str).filter((w) => !LEGAL.has(w));
}

function slugOf(str) {
  return words(str).map(encodeURIComponent).join('-');
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

// Checks one openings page. The page title names the company it is about; an unknown name gives a generic
// title ("Openings Jobs - N Openings Job Vacancies in <month year>") with no company, which means not listed.
async function checkSlug(keyword, slug, want) {
  const url = `${BASE}${slug}-openings`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IN,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', url, err?.message || err);
  }

  if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
  if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

  let html;
  try {
    html = await res.text();
  } catch (err) {
    return fail(err?.name === 'TimeoutError' ? 'timeout' : 'other', url, err?.message || err);
  }

  if (!/Openings? Jobs?/i.test(html)) {
    if (/captcha|access denied|are you a robot|verify you are human|cf-chl|attention required/i.test(html)) {
      return fail('blocked', url, 'bot or captcha page');
    }
    return fail('layout_changed', url, html.slice(0, 200));
  }

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(titleMatch ? titleMatch[1] : '').replace(/\s+/g, ' ').trim();
  const m = title.match(/Openings Jobs in (.+?) - ([\d,]+) /i);

  if (!m) {
    return { status: 'not_found', reason: '', records: [], source_url: url,
      excerpt: `Shine openings page for "${keyword}" names no company (title: "${title.slice(0, 120)}")` };
  }

  const company = m[1].replace(/\s+/g, ' ').trim();
  const openings = parseInt(m[2].replace(/,/g, ''), 10);

  if (coreWords(company).join('') !== want) {
    return { status: 'not_found', reason: '', records: [], source_url: url,
      excerpt: `Shine page is for "${company}", not "${keyword}"` };
  }

  if (!Number.isFinite(openings) || openings === 0) {
    return { status: 'not_found', reason: '', records: [], source_url: url,
      excerpt: `"${company}" has 0 openings on Shine` };
  }

  return {
    status: 'found',
    reason: '',
    records: [{ name: company, openings, url }],
    source_url: url,
    excerpt: title.slice(0, 300),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword ?? '').trim();
    const want = coreWords(name).join('');
    if (!name || !want) {
      return fail('other', BASE, 'the name has no words other than a legal form');
    }

    // Try the name as typed first, then the same name without its legal form (Shine often omits "Ltd" / "Limited").
    const slugs = [slugOf(name)];
    const core = slugOf(coreWords(name).join(' '));
    if (core && core !== slugs[0]) slugs.push(core);

    let firstMiss = null;
    for (const slug of slugs) {
      const r = await checkSlug(name, slug, want);
      if (r.status === 'found') return r;
      if (r.status === 'couldnt_check') return r;
      if (!firstMiss) firstMiss = r;
    }
    return firstMiss;
  } catch (err) {
    return fail('other', BASE, err?.message || err);
  }
}
