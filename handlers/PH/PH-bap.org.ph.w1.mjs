export const meta = {
  task: 'PH-bap.org.ph',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category'],
  canary: { found: 'Bank of the Philippine Islands', not_found: 'Bangko Sampaguita ng Pilipinas' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MEMBERSHIP_URL = 'https://bap.org.ph/membership.html';
const AFFILIATES_URL = 'https://bap.org.ph/subsidiaries-affiliates.html';

const ENTITIES = new Map([
  ['amp', '&'], ['nbsp', ' '], ['ntilde', 'ñ'], ['Ntilde', 'Ñ'],
  ['rsquo', '’'], ['lsquo', '‘'], ['rdquo', '”'], ['ldquo', '“'],
  ['ndash', '–'], ['mdash', '—'],
]);

// Legal-form and filler words that do not decide whether two names are the same company.
const LEGAL_WORDS = new Set(['the', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
  'na', 'n', 'a', 'pcl', 'nv', 'ag', 'sa', 'plc']);

/** Decode HTML entities and tags into plain text. */
function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (ENTITIES.has(name) ? ENTITIES.get(name) : m))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised core of a company name: case, punctuation, legal form and branch words removed. */
function core(name) {
  const s = decode(name).toLowerCase()
    .replace(/\bmanila\s+branch\b/g, ' ')
    .replace(/\bbranch\b/g, ' ');
  return s.split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL_WORDS.has(t)).join('');
}

/** Member banks: every <div class="member-details"> under each <h2> section (HTML comments already removed). */
function parseMembership(html) {
  const out = [];
  const heads = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  heads.forEach((m, i) => {
    const category = decode(m[1]);
    const end = i + 1 < heads.length ? heads[i + 1].index : html.length;
    const segment = html.slice(m.index, end);
    for (const d of segment.matchAll(/<div class="member-details">\s*<strong>([\s\S]*?)<\/strong>/gi)) {
      const name = decode(d[1]);
      if (name) out.push({ name, category });
    }
  });
  return out;
}

/** Subsidiaries and affiliates: one display-4 <h3> per entity. */
function parseAffiliates(html) {
  return [...html.matchAll(/<h3[^>]*class="[^"]*display-4[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi)]
    .map((m) => decode(m[1]))
    .filter(Boolean)
    .map((name) => ({ name, category: 'Subsidiaries and Affiliates' }));
}

/** Fetch one page. Returns { html } or { fail, status, error, url }. Never throws. */
async function getPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: timedOut ? 'timeout' : 'other', status: 0, error: String(err?.message || err).slice(0, 200), url };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    return { fail: 'blocked', status: res.status, error: '', url };
  }
  if (!res.ok) {
    return { fail: 'http_error', status: res.status, error: '', url };
  }
  let html;
  try {
    html = await res.text();
  } catch (err) {
    return { fail: 'other', status: res.status, error: String(err?.message || err).slice(0, 200), url };
  }
  if (/captcha|cf-chl|challenge-platform/i.test(html) && !html.includes('member-details') && !html.includes('display-4')) {
    return { fail: 'blocked', status: res.status, error: 'bot check page', url };
  }
  return { html: html.replace(/<!--[\s\S]*?-->/g, '') };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the sockets from fetch finish closing before the worker exits. Without this pause, Node 24 on Windows
  // aborts with exit code 127 after the answer is printed (seen with a bare fetch + process.exit, not specific to this site).
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const input = String(keyword || '').trim();
  const key = core(input);
  if (!key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: MEMBERSHIP_URL, excerpt: 'empty company name' };
  }
  try {
    const sources = [
      { url: MEMBERSHIP_URL, parse: parseMembership, label: 'membership' },
      { url: AFFILIATES_URL, parse: parseAffiliates, label: 'subsidiaries and affiliates' },
    ];
    const checked = [];
    for (const src of sources) {
      const page = await getPage(src.url);
      if (page.fail) {
        return {
          status: 'couldnt_check', reason: page.fail, records: [], source_url: page.url,
          excerpt: `${src.label}: ${page.status ? `HTTP ${page.status}` : page.error}`.slice(0, 300),
        };
      }
      const listed = src.parse(page.html);
      if (listed.length === 0) {
        return {
          status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: src.url,
          excerpt: `${src.label}: no entries found in the expected layout`,
        };
      }
      checked.push(`${src.label} (${listed.length} entries)`);
      const matches = listed.filter((e) => core(e.name) === key);
      if (matches.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: matches.map((m) => ({ name: m.name, category: m.category })),
          source_url: src.url,
          excerpt: `${matches[0].category}: ${matches.map((m) => m.name).join(' | ')}`.slice(0, 500),
        };
      }
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: MEMBERSHIP_URL,
      excerpt: `No BAP member bank or affiliate named "${input}". Checked ${checked.join(' and ')}.`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: MEMBERSHIP_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
