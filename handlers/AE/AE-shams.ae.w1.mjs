export const meta = {
  task: 'AE-shams.ae',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'sector', 'client_type'],
  canary: { found: 'Roots and Wings Learning LLC', not_found: 'شركة غير مدرجة للاختبار ذ.م.م' },
};

// The Shams company directory page has no search endpoint. Its search box filters a list that is written into the
// page itself (a JavaScript array named `companies`). So the handler reads that list from the English page.
const PAGE_URL = 'https://www.shams.ae/community/company-directory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words, removed from both sides before comparing (after punctuation is stripped).
const LEGAL_FORMS = new Set([
  'llc', 'fz', 'fzllc', 'fze', 'fzco', 'ltd', 'limited', 'inc', 'corp', 'co', 'company', 'pjsc', 'psc', 'sdn', 'bhd',
  'شركه', 'ذمم', 'شذمم', 'شمم', 'شمع', 'شم', 'ذم', 'ش', 'ذ', 'م', 'ع',
]);

function normalise(str) {
  const s = String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٟـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.split(' ').filter((w) => w && !LEGAL_FORMS.has(w)).join(' ');
}

function unescapeJs(s) {
  return s.replace(/\\(.)/g, '$1');
}

/** Read the embedded company list. Returns null when the page is not the expected layout. */
function parseCompanies(html) {
  if (!html.includes('id="searchInput"') || !html.includes('id="cardsContainer"')) return null;
  const start = html.indexOf('const companies');
  if (start < 0) return null;
  const endRel = html.indexOf('const cardsContainer', start);
  const block = html.slice(start, endRel > start ? endRel : undefined);
  const out = [];
  for (const chunk of block.split(/\bid:\s*\d+\s*,/).slice(1)) {
    const name = chunk.match(/\bname:\s*'((?:[^'\\]|\\.)*)'/);
    if (!name) continue;
    const sub = chunk.match(/\bsubtitle:\s*'((?:[^'\\]|\\.)*)'/);
    const type = chunk.match(/companyType:\s*'((?:[^'\\]|\\.)*)'/);
    out.push({
      name: unescapeJs(name[1]).trim(),
      sector: sub ? unescapeJs(sub[1]).trim() : '',
      client_type: type ? unescapeJs(type[1]).trim() : '',
    });
  }
  return out.length ? out : null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = normalise(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE_URL, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const companies = parseCompanies(html);
    if (!companies) {
      if (/captcha|cf-chl|just a moment|access denied/i.test(html.slice(0, 20000))) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: 'bot or access check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: html.slice(0, 300) };
    }

    const matches = companies.filter((c) => normalise(c.name) === want);
    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: `No entry named "${String(keyword).trim()}" among the ${companies.length} entries on the directory page`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({ name: m.name, sector: m.sector, client_type: m.client_type })),
      source_url: PAGE_URL,
      excerpt: matches.map((m) => `${m.name} - ${m.sector}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
