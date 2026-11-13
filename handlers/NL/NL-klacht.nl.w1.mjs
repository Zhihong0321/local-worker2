export const meta = {
  task: 'NL-klacht.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'url', 'complaints_total', 'resolved_pct', 'satisfaction', 'satisfaction_votes', 'complaints_last_12m'],
  canary: { found: 'Spotta', not_found: 'Bakkerij De Zwaluwhof Vof' },
};

const SITE = 'https://www.klacht.nl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5',
};
// Dutch legal forms, written without dots (B.V. -> BV). Stripped only at the end of a name.
const LEGAL_FORMS = new Set(['bv', 'nv', 'vof', 'cv', 'maatschap', 'eenmanszaak', 'commv']);
const BOT_CHECK_RE = /captcha|challenge-platform|cf-chl|just a moment|verifying you are human|access denied/i;
const MAX_DETAIL = 3;

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: case, accents, dots, punctuation and trailing legal form ignored. */
function normalizeName(s) {
  const words = (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const text = res.ok ? await res.text() : '';
  return { status: res.status, ok: res.ok, url: res.url || url, text };
}

/** Company cards in the "Bedrijven" block of a search results page. */
function parseCompanyCards(html) {
  const start = html.indexOf('search-block search-company');
  if (start < 0) return [];
  const rest = html.slice(start);
  const end = rest.indexOf('</section>');
  const block = end >= 0 ? rest.slice(0, end) : rest;
  return block.split('<article class="c-box company"').slice(1).map((chunk) => {
    const link = chunk.match(/<h1>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) return null;
    const cat = chunk.match(/Categorie:\s*<a[^>]*>([\s\S]*?)<\/a>/);
    return { url: link[1].replace(/&amp;/g, '&'), name: cleanText(link[2]), category: cat ? cleanText(cat[1]) : '' };
  }).filter(Boolean);
}

/** Adds the statistics from the company page. Never fails: the company is already found from the search. */
async function withDetail(card) {
  const rec = {
    name: card.name, category: card.category, url: card.url,
    complaints_total: null, resolved_pct: null, satisfaction: null, satisfaction_votes: null, complaints_last_12m: null,
  };
  try {
    const d = await get(card.url);
    if (!d.ok) return { rec, excerpt: `company page HTTP ${d.status}` };
    const html = d.text;
    const total = html.match(/([\d.]+) klachten ingediend, waarvan (\d+)% opgelost/);
    const sat = html.match(/Gemiddelde klanttevredenheid ([\d.,]+)\/10 op basis van ([\d.]+) beoordelingen/);
    const last12 = html.match(/In de afgelopen 12 maanden kwamen er ([\d.]+) klachten bij/);
    if (total) {
      rec.complaints_total = parseInt(total[1].replace(/\./g, ''), 10);
      rec.resolved_pct = parseInt(total[2], 10);
    }
    if (sat) {
      rec.satisfaction = parseFloat(sat[1].replace(',', '.'));
      rec.satisfaction_votes = parseInt(sat[2].replace(/\./g, ''), 10);
    }
    if (last12) rec.complaints_last_12m = parseInt(last12[1].replace(/\./g, ''), 10);
    const sentence = (total && total[0]) || '';
    return { rec, excerpt: sentence || 'company page read, no statistics sentence found' };
  } catch (err) {
    return { rec, excerpt: `company page: ${String(err && err.message || err)}` };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the last keep-alive socket finish closing before the worker exits (Node on Windows aborts otherwise).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const q = String(keyword || '').trim();
  const searchUrl = `${SITE}/?s=${encodeURIComponent(q)}`;
  try {
    if (!normalizeName(q)) return fail('other', searchUrl, 'empty company name');

    const s = await get(searchUrl);
    if (s.status === 403 || s.status === 429) return fail('blocked', searchUrl, `HTTP ${s.status}`);
    if (!s.ok) return fail('http_error', searchUrl, `HTTP ${s.status}`);

    const html = s.text;
    if (!/Zoekresultaten/.test(html)) {
      if (BOT_CHECK_RE.test(html)) return fail('blocked', searchUrl, 'bot check page instead of search results');
      return fail('layout_changed', searchUrl, cleanText(html).slice(0, 300));
    }

    const cards = parseCompanyCards(html);
    if (cards.length === 0) {
      if (/Niets gevonden|<p>\s*0 Zoekresultaten/.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
          excerpt: `Klacht.nl search for "${q}": 0 results` };
      }
      return fail('layout_changed', searchUrl, 'search results page has no company block and no "0 results" text');
    }

    const wanted = normalizeName(q);
    const seen = new Set();
    const matches = cards.filter((c) => {
      if (normalizeName(c.name) !== wanted || seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    });
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `No exact match for "${q}". Site lists: ${cards.slice(0, 5).map((c) => c.name).join('; ')}` };
    }

    const details = await Promise.all(matches.slice(0, MAX_DETAIL).map(withDetail));
    return {
      status: 'found',
      reason: '',
      records: details.map((d) => d.rec),
      source_url: details[0].rec.url,
      excerpt: details[0].excerpt,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', searchUrl, String((err && err.message) || err));
  }
}
