export const meta = {
  task: 'CH-jobup.ch',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'location', 'employees', 'profile_url'],
  canary: { found: 'KONE (Schweiz) AG', not_found: 'Société Fictive Inexistante SA' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.jobup.ch';

// Legal-form words removed from the end of a name before comparing.
const LEGAL_FORMS = new Set(['sa', 'ag', 'gmbh', 'sarl', 'sagl', 'sl', 'ltd', 'llc', 'inc', 'slu', 'bv', 'nv', 'kg', 'ohg', 'srl', 'spa']);

function normalizeName(str) {
  const s = (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // accents: Sàrl -> Sarl
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const parts = s.split(' ').filter(Boolean);
  while (parts.length > 1 && LEGAL_FORMS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

function decodeEntities(str) {
  return (str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Text that is visible on the page (scripts carry translation tables that also contain the phrases).
function visibleText(html) {
  return cleanText(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
}

function parseCards(html) {
  const parts = html.split('data-cy="card"').slice(1);
  const cards = [];
  for (const part of parts) {
    const nameMatch = part.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const linkMatch = part.match(/href="(\/fr\/societes\/[^"]+)"/i);
    if (!nameMatch) continue;
    const locMatch = part.match(/data-cy="company-card-location"[^>]*>([\s\S]*?)<\/(?:p|span|div)>/i);
    const empMatch = part.match(/data-cy="company-card-employees"[^>]*>([\s\S]*?)<\/(?:p|span|div)>/i);
    cards.push({
      name: cleanText(nameMatch[1]),
      location: locMatch ? cleanText(locMatch[1]) : '',
      employees: empMatch ? cleanText(empMatch[1]) : '',
      profile_url: linkMatch ? new URL(decodeEntities(linkMatch[1]), BASE).href : '',
    });
  }
  return cards;
}

// One search request. Returns { ok: true, cards, empty, html } or { ok: false, result } with a couldnt_check result.
async function search(term) {
  const searchUrl = `${BASE}/fr/societes/?term=${encodeURIComponent(term)}`;
  let res;
  try {
    res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-CH,fr;q=0.9,en;q=0.7',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, result: { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: searchUrl, excerpt: String(err?.message || err).slice(0, 300) } };
  }

  if (res.status === 403 || res.status === 429) {
    return { ok: false, result: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { ok: false, result: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` } };
  }

  const html = await res.text();

  // Bot / challenge pages
  if (/cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required|g-recaptcha|hcaptcha/i.test(html)) {
    return { ok: false, result: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: visibleText(html).slice(0, 300) } };
  }

  const hasResults = html.includes('data-cy="company-search-serp"');
  const text = visibleText(html);
  const empty = text.includes('Aucune entreprise ne correspond à votre recherche');

  if (!hasResults && !empty) {
    return { ok: false, result: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) } };
  }

  return { ok: true, cards: hasResults ? parseCards(html) : [], empty, searchUrl };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const firstUrl = `${BASE}/fr/societes/?term=${encodeURIComponent(keyword)}`;
  try {
    const kwNorm = normalizeName(keyword);
    if (!kwNorm) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl, excerpt: 'empty name' };
    }

    // The site search can return nothing for a name with its legal form (e.g. "... SA"), while the
    // name without it is listed. So: try the name as typed, then the same name without the legal form.
    const terms = [String(keyword).trim()];
    const stripped = String(keyword).trim().split(/\s+/).filter(Boolean);
    while (stripped.length > 1 && LEGAL_FORMS.has(normalizeName(stripped[stripped.length - 1]))) stripped.pop();
    const strippedTerm = stripped.join(' ');
    if (strippedTerm && strippedTerm !== terms[0]) terms.push(strippedTerm);

    let lastSearchUrl = firstUrl;
    let answeredEmpty = false;
    let lastSeen = [];

    for (const term of terms) {
      const r = await search(term);
      if (!r.ok) return r.result;   // a refused or broken search is never "not found"
      lastSearchUrl = r.searchUrl;

      const matches = r.cards.filter((c) => normalizeName(c.name) === kwNorm);
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches.map((c) => ({ name: c.name, location: c.location, employees: c.employees, profile_url: c.profile_url })),
          source_url: r.searchUrl,
          excerpt: matches.map((c) => [c.name, c.location, c.employees].filter(Boolean).join(' · ')).join(' || ').slice(0, 500),
        };
      }
      answeredEmpty = answeredEmpty || r.empty || r.cards.length === 0;
      lastSeen = r.cards.map((c) => c.name).slice(0, 10);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastSearchUrl,
      excerpt: lastSeen.length
        ? `${terms.length} search(es) answered; results with other names: ${lastSeen.join(' | ')}`
        : (answeredEmpty ? 'Aucune entreprise ne correspond à votre recherche.' : 'no matching company'),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
