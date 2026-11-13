export const meta = {
  task: 'IE-limerickchamber.ie',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'phone', 'membership_type', 'category', 'website', 'directory_url', 'member_id'],
  canary: { found: 'Analog Devices International UC', not_found: 'Cuideachta Dhezeno Teoranta' },
};

const BASE = 'https://members.limerickchamber.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};
// Legal-form words (Irish and UK). Removed from both sides before two names are compared.
const LEGAL_FORM = new Set(['ltd', 'limited', 'uc', 'unlimited', 'company', 'co', 'plc', 'dac', 'teoranta', 'teo', 'cta', 'cuideachta', 'inc', 'llc', 'llp']);

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt };
}

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised name for comparison: no accents, case, punctuation or legal form. */
function core(name) {
  return decode(name)
    .replace(/&/g, ' and ')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORM.has(w))
    .join('');
}

/** One object per result card on the directory search page. */
function parseCards(html) {
  const cards = [];
  for (const part of html.split('<div class="card gz-results-card ').slice(1)) {
    const nameM = part.match(/<h5[^>]*gz-card-title[^>]*>[\s\S]*?<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!nameM) continue;
    const addrLi = (part.match(/<li[^>]*gz-card-address[\s\S]*?<\/li>/i) || [''])[0];
    const address = [...addrLi.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((m) => cleanText(m[1])).filter(Boolean).join(', ');
    const phoneLi = (part.match(/<li[^>]*gz-card-phone[\s\S]*?<\/li>/i) || [''])[0];
    cards.push({
      name: cleanText(nameM[2]),
      directory_url: new URL(decode(nameM[1]), BASE).href,
      member_id: (part.match(/data-memid="(\d+)"/) || [])[1] || '',
      membership_type: cleanText((part.match(/<span[^>]*gz-membership-type[^>]*>([\s\S]*?)<\/span>/i) || [])[1]),
      address,
      phone: cleanText((phoneLi.match(/<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1]),
    });
  }
  return cards;
}

/** Category and website from the member's own page. Blank if that page cannot be read. */
async function detailFields(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return { category: '', website: '' };
    const html = await r.text();
    const cats = [...html.matchAll(/<span class="gz-cat">([\s\S]*?)<\/span>/gi)].map((m) => cleanText(m[1])).filter(Boolean);
    const web = (html.match(/<a href="([^"]+)"[^>]*onclick="MNI\.Hit\.MemberWebsite/i) || [])[1] || '';
    return { category: cats.join(', '), website: decode(web) };
  } catch {
    return { category: '', website: '' };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows can hit an assertion when the runner exits while a fetch socket is still closing
  // (exit code 127 after the answer is printed). A short pause lets the sockets settle before the answer is returned.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const name = String(keyword || '').trim();
  const searchUrl = `${BASE}/list/search?q=${encodeURIComponent(name)}`;
  try {
    const wanted = core(name);
    if (!wanted) return fail('couldnt_check', 'other', searchUrl, 'no letters left in the name after removing the legal form');

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const isResultsPage = /gz-results-count|gz-members-empty|gz-results-card/.test(html);
    if (!isResultsPage) {
      if (/challenge-platform|cf-chl|Just a moment/i.test(html)) return fail('couldnt_check', 'blocked', searchUrl, 'bot check page');
      return fail('couldnt_check', 'layout_changed', searchUrl, cleanText(html).slice(0, 300));
    }

    const countM = html.match(/gz-results-count">\s*(\d+)/);
    const cards = parseCards(html.replace(/<script[\s\S]*?<\/script>/gi, ''));

    if (cards.length === 0) {
      if ((countM && countM[1] === '0') || /gz-members-empty/.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `Results Found: 0 for "${name}"` };
      }
      return fail('couldnt_check', 'layout_changed', searchUrl, `count ${countM ? countM[1] : 'missing'} but no result cards parsed`);
    }

    const matches = cards.filter((c) => core(c.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Results Found: ${cards.length} for "${name}", none with this company name`,
      };
    }

    const records = await Promise.all(matches.map(async (m) => ({ ...m, ...(await detailFields(m.directory_url)) })));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records.map((r) => `${r.name} | ${r.address} | ${r.phone} | ${r.membership_type}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err).slice(0, 300));
  }
}
