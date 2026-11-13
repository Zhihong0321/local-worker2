export const meta = { task: 'FR-meteojob.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'company_id', 'profile_url', 'profile_name'],
  canary: { found: 'WURTH FRANCE', not_found: 'Quincaillerie Zorbavelle' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.meteojob.com';
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'sci', 'snc', 'sep', 'gmbh', 'ltd', 'llc', 'inc', 'plc', 'ag', 'bv', 'srl', 'spa']);

/** Compare names: case, accents, punctuation and legal-form words do not count. */
function normalize(str) {
  return (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join('');
}

/** Search wording: the site's own search returns nothing when a legal form or an accent is typed, so those are dropped for a retry. */
function cleanQuery(str) {
  return (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !LEGAL_FORMS.has(w.toLowerCase()))
    .join(' ');
}

function decode(str) {
  return (str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlockPage(html) {
  return /captcha|cf-chl|Just a moment|access denied|connexion requise/i.test(html);
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5' },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, ok: res.ok, text: res.ok ? await res.text() : '' };
}

/** Each match is an <a class="... sheet-link"> card; the name sits in <div class="text-content"><span>NAME</span>. */
function parseCards(html) {
  const cards = [];
  const cardRe = /<a\s[^>]*href="([^"]*\/pages-entreprises\/emploi-[^"]*-e-(\d+))"[^>]*class="[^"]*sheet-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const nameMatch = m[3].match(/<div class="text-content[^"]*">\s*<span>([\s\S]*?)<\/span>/);
    if (!nameMatch) continue;
    cards.push({ name: decode(nameMatch[1]), company_id: m[2], profile_url: new URL(decode(m[1]), BASE).href });
  }
  return cards;
}

/** Run one search. Returns { cards } or { fail } with the couldnt_check answer to give. */
async function search(query) {
  const url = `${BASE}/company/sheets?query=${encodeURIComponent(query)}`;
  const res = await getText(url);
  if (res.status === 403 || res.status === 429) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` } };
  }
  const html = res.text;
  if (!html.includes('id="sheet-list"')) {
    // The normal page always carries a captcha widget (password reset), so the bot check is only read when the results list is missing.
    if (isBlockPage(html)) {
      return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'captcha or bot check page' } };
    }
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: html.slice(0, 300) } };
  }
  const cards = parseCards(html);
  if (cards.length === 0 && /sheet-link/.test(html)) {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'sheet links present but no names parsed' } };
  }
  return { cards, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}/company/sheets?query=${encodeURIComponent(keyword)}`;
  try {
    let result = await search(keyword);
    if (result.fail) return result.fail;
    let usedUrl = result.url;

    // Nothing for the name as typed: retry once without legal form and accents, then match on normalised names as before.
    const alt = cleanQuery(keyword);
    if (result.cards.length === 0 && alt && alt !== keyword) {
      const retry = await search(alt);
      if (retry.fail) return retry.fail;
      result = retry;
      usedUrl = retry.url;
    }

    const cards = result.cards;
    if (cards.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: usedUrl, excerpt: `0 company sheets for "${keyword}"` };
    }

    const target = normalize(keyword);
    const matches = cards.filter((c) => normalize(c.name) === target);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: usedUrl,
        excerpt: `${cards.length} result(s), none matches "${keyword}": ${cards.map((c) => c.name).join(' | ')}`.slice(0, 500),
      };
    }

    // Profile page gives the name as the site writes it on the company page. A failure here keeps the search name.
    const records = [];
    for (const c of matches) {
      let profileName = '';
      try {
        const prof = await getText(c.profile_url);
        if (prof.ok) {
          const h1 = prof.text.match(/<h1 class="sheet-title">([\s\S]*?)<\/h1>/);
          if (h1) profileName = decode(h1[1]);
        }
      } catch (_) { /* keep search name */ }
      records.push({ name: c.name, company_id: c.company_id, profile_url: c.profile_url, profile_name: profileName || c.name });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: usedUrl,
      excerpt: records.map((r) => `${r.name} (id ${r.company_id})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
