export const meta = {
  task: 'CA-ccmm.ca',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership_level', 'sectors', 'delegates_count', 'profile_url'],
  canary: { found: 'Banque Nationale', not_found: 'Entreprise Fictive Introuvable' },
};

// The CCMM member directory gives every member company its own page at /fr/entreprises/<slug>/.
// The slug is the company name lower-cased, accents removed, every other character turned into "-".
// A listed company answers 200; an unlisted one answers 404 (verified on the live site).
const BASE = 'https://www.ccmm.ca/fr/entreprises/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_RE = /[\s,]+(?:inc\.?|incorporated|ltd\.?|ltée|ltee|corp\.?|corporation|s\.?e\.?n\.?c\.?r?\.?l\.?|llp|l\.?p\.?)$/i;

function stripLegal(s) {
  let out = String(s || '').replace(/\s+/g, ' ').trim().replace(/[\s,]+$/, '');
  let prev;
  do {
    prev = out;
    out = out.replace(LEGAL_RE, '').trim();
  } while (out !== prev);
  return out;
}

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function normName(s) {
  return slugify(stripLegal(s)).replace(/-/g, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&rsquo;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(html) {
  return decode(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

function unavailable(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

async function lookupOnce(keyword) {
  try {
    const kw = String(keyword || '').replace(/\s+/g, ' ').trim();
    if (!kw) return unavailable('other', BASE, 'empty company name');

    // Candidate slugs: the name as typed, then the name without its legal form.
    // Two at most, so the whole call stays well under 60 s.
    const base = stripLegal(kw);
    const slugs = [slugify(kw), slugify(base)];
    if (base === kw) slugs.push(slugify(kw + ' inc.'));
    const candidates = [...new Set(slugs.filter(Boolean))];

    for (const slug of candidates) {
      const url = BASE + slug + '/';
      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.7' },
          signal: AbortSignal.timeout(25000),
        });
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return unavailable(timedOut ? 'timeout' : 'other', url, String(e?.message || e).slice(0, 300));
      }

      if (res.status === 403 || res.status === 429) return unavailable('blocked', url, `HTTP ${res.status}`);
      if (res.status === 404) continue; // no member page under this slug
      if (!res.ok) return unavailable('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (/captcha|cf-chl|verify you are human|access denied/i.test(html)) return unavailable('blocked', url, 'bot check page');
      if (!html.includes('Répertoire des membres')) return unavailable('layout_changed', url, cleanText(html).slice(0, 300));

      const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
      const name = titleMatch ? decode(titleMatch[1]).split('|')[0].trim() : '';
      if (!name) return unavailable('layout_changed', url, 'profile page has no title');
      if (normName(name) !== normName(kw)) continue; // a different company sits under this slug

      // Profile block: "<name> <membership level> <NAICS code> - <sector>", then "Délégués (n)".
      const text = cleanText(html);
      const start = text.indexOf('Retour à la page précédente');
      const end = start < 0 ? -1 : text.indexOf('Délégués (', start);
      if (start < 0 || end < 0) return unavailable('layout_changed', url, text.slice(0, 300));

      const block = text.slice(start + 'Retour à la page précédente'.length, end).trim();
      const rest = block.startsWith(name) ? block.slice(name.length).trim() : block;
      const firstCode = rest.search(/\d{2,6}\s*-\s*/);
      const membership = firstCode >= 0 ? rest.slice(0, firstCode).trim() : rest;
      const sectors = [];
      const codeRe = /(\d{2,6})\s*-\s*(.+?)(?=\s+\d{2,6}\s*-\s*|$)/g;
      for (const m of (firstCode >= 0 ? rest.slice(firstCode) : '').matchAll(codeRe)) {
        sectors.push({ code: m[1], name: m[2].trim() });
      }
      const delegates = text.slice(start).match(/Délégués \((\d+)\)/);

      return {
        status: 'found',
        reason: '',
        records: [{
          name,
          membership_level: membership,
          sectors,
          delegates_count: delegates ? Number(delegates[1]) : null,
          profile_url: url,
        }],
        source_url: url,
        excerpt: block.slice(0, 300),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: BASE + candidates[0] + '/',
      excerpt: `No CCMM member page for "${kw}" (tried ${candidates.map((s) => BASE + s + '/').join(', ')}; each answered 404)`,
    };
  } catch (err) {
    return unavailable('other', BASE, String(err?.message || err).slice(0, 300));
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await lookupOnce(keyword);
  } catch (err) {
    answer = unavailable('other', BASE, String(err?.message || err).slice(0, 300));
  }
  // Let the keep-alive sockets close before the worker process exits (Node 24 on Windows asserts otherwise).
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}
