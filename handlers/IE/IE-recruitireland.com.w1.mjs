export const meta = { task: 'IE-recruitireland.com', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'profile_url', 'locations'], canary: { found: 'MSD', not_found: 'Comhlacht Dochreidte Teoranta' } };

const BASE = 'https://www.recruitireland.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'dac', 'teoranta', 'teo', 'plc', 'uc', 'unlimited', 'company', 'co', 'gmbh', 'inc', 'llc', 'llp', 'ag', 'sa', 'bv', 'nv']);

/** Drop a trailing legal form (Ltd, DAC, Teoranta, GmbH ...) from a company name. */
function stripLegal(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ''))) words.pop();
  return words.join(' ');
}

/** Comparison form: no legal form, no accents, no case, no punctuation. */
function core(name) {
  return stripLegal(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&#x27;|&rsquo;/gi, "'").replace(/\s+/g, ' ').trim();
}

function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IE,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
}

/** The employer profile page lists its locations (icon-location rows). null = profile could not be read. */
async function locations(url) {
  try {
    const res = await get(url);
    if (!res.ok) return null;
    const html = await res.text();
    const list = [...html.matchAll(/<i class="icon-location[^"]*"><\/i>\s*<span>([\s\S]*?)<\/span>/g)].map((m) => clean(m[1])).filter(Boolean);
    return [...new Set(list)];
  } catch {
    return null;
  }
}

const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const query = stripLegal(keyword);
  const searchUrl = `${BASE}/search/companies?query=${encodeURIComponent(query)}`;
  try {
    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (/<title>[^<]*(Just a moment|Attention Required|Access denied)/i.test(html)) return fail('blocked', searchUrl, 'bot check page');

    const countMatch = html.match(/<span>\s*([\d,]+)\s+compan(?:y|ies) found\s*<\/span>/i);
    if (!countMatch) return fail('layout_changed', searchUrl, clean(html));
    const total = parseInt(countMatch[1].replace(/,/g, ''), 10);

    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 companies found for "${query}"` };
    }

    // Result cards of the results grid (not the featured list). Each card: link to /company/<slug>, then its name.
    const cards = [...html.matchAll(/<a href="(https:\/\/www\.recruitireland\.com\/company\/[^"/]+)"\s+class="bg-2-grey-50 rounded-md[^"]*"[\s\S]*?<p class="text-xl[^"]*">([\s\S]*?)<\/p>/g)]
      .map((m) => ({ url: m[1], name: clean(m[2]) }));
    if (cards.length === 0) return fail('layout_changed', searchUrl, `${total} results counted, no result cards parsed`);

    const want = core(keyword);
    const matches = cards.filter((c) => core(c.name) === want);
    if (matches.length === 0) {
      if (total > cards.length) return fail('other', searchUrl, `${total} results; the exact name is not on the first page`);
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `${total} companies found for "${query}", none with this name` };
    }

    const records = await Promise.all(matches.map(async (m) => ({ name: m.name, profile_url: m.url, locations: await locations(m.url) })));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `Listed on RecruitIreland as "${matches.map((m) => m.name).join('", "')}"`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
