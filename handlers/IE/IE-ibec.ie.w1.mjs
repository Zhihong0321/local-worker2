export const meta = {
  task: 'IE-ibec.ie',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'website', 'directory'],
  canary: { found: 'Dell Technologies', not_found: 'Comhlacht Neamhliostaithe Teoranta' },
};

// Ibec publishes one company list: the Technology Ireland member directory (member logos, each with its website).
// It is a plain HTML page, so no search request is needed.
const DIRECTORY_URL = 'https://www.ibec.ie/technologyireland/about-us/member-directory';
const DIRECTORY_NAME = 'Technology Ireland member directory (Ibec)';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that do not change which company is meant.
const LEGAL_WORDS = new Set([
  'ltd', 'limited', 'plc', 'dac', 'uc', 'teoranta', 'inc', 'incorporated', 'llc', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'bv', 'ag', 'sa', 'unlimited',
]);

function normalize(str) {
  const tokens = (str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LEGAL_WORDS.has(t));
  return tokens.join('');
}

function decodeEntities(str) {
  return (str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Short pause before the answer is handed back: on Windows, Node sometimes aborts at exit while fetch sockets are
  // still closing (exit code 127 after the answer was printed). 500 ms avoids it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  try {
    const res = await fetch(DIRECTORY_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!html.includes('Member Directory') || !html.includes('logos-grid')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: html.slice(0, 300) };
    }

    // The first logos-grid holds the member companies; the second one holds the sub-associations.
    const start = html.indexOf('logos-grid');
    const second = html.indexOf('logos-grid', start + 10);
    const section = html.slice(start, second === -1 ? undefined : second);

    const members = [];
    const anchorRe = /<a\s+href="([^"]*)"[^>]*>\s*<img[^>]*?\salt="([^"]*)"/gi;
    let m;
    while ((m = anchorRe.exec(section)) !== null) {
      const name = decodeEntities(m[2]);
      if (name) members.push({ name, website: decodeEntities(m[1]) });
    }

    if (members.length < 20) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL,
        excerpt: `only ${members.length} member logos found in the directory page` };
    }

    const kwNorm = normalize(keyword);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'empty company name' };
    }

    const matches = members.filter((mem) => normalize(mem.name) === kwNorm);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: DIRECTORY_URL,
        excerpt: `Not in the ${DIRECTORY_NAME}: ${members.length} member logos checked, none named "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((mem) => ({ name: mem.name, website: mem.website, directory: DIRECTORY_NAME })),
      source_url: DIRECTORY_URL,
      excerpt: `Listed in the ${DIRECTORY_NAME} as "${matches[0].name}" (${members.length} member logos on the page)`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: DIRECTORY_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
