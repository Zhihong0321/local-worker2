// Jobijoba company lookup (tier 1, url_template).
// Company profile pages live at https://www.jobijoba.com/fr/entreprises/<Name>/avis (spaces written as "+").
// The slug is case-sensitive on the site ("Carrefour" = 200, "carrefour" = 404), so a few casings are tried.
// A 200 page counts as a match only when its title ("Avis <Name> - ...") matches the input after
// removing case, accents, punctuation and legal-form words. A 404 with the site's own error page means "not listed".

export const meta = { task: 'FR-jobijoba.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'profile_url'], canary: { found: 'Carrefour', not_found: 'Société Introuvable Zqxw SAS' } };

const SITE = 'https://www.jobijoba.com/fr/entreprises/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 25000;
const START_LIMIT_MS = 30000; // do not start a new fetch after 30 s, so the whole call ends under 60 s
const LEGAL = new Set(['sas', 'sasu', 'sa', 'sarl', 'eurl', 'sci', 'snc', 'se', 'sem', 'scop', 'gmbh', 'ag', 'ltd',
  'llc', 'inc', 'corp', 'plc', 'llp', 'spa', 'srl', 'bv', 'nv', 'sdn', 'bhd', 'pte', 'co', 'ab', 'oy', 'kg', 'sl', 'slu']);

const out = (status, reason, records, source_url, excerpt) =>
  ({ status, reason, records, source_url, excerpt });

function fold(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// "S.A.S." -> "SAS", then drop punctuation and legal-form words, keep the core name.
function coreKey(s) {
  const words = fold(String(s).replace(/\b([A-Za-z])\.(?=[A-Za-z])/g, '$1'))
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return words.filter((w) => !LEGAL.has(w)).join(' ');
}

function stripLegal(s) {
  return String(s).replace(/\b([A-Za-z])\.(?=[A-Za-z])/g, '$1').split(/\s+/)
    .filter((w) => w && !LEGAL.has(fold(w).replace(/[^a-z0-9]/g, ''))).join(' ');
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
}

function slug(s) {
  return s.trim().split(/\s+/).map((w) => encodeURIComponent(w)).join('+');
}

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').trim();
}

function candidates(core, base) {
  const hyphenBase = base.replace(/\s+/g, '-');
  const list = [core, titleCase(core), core.toUpperCase(), titleCase(base).replace(/\s+/g, '-'), hyphenBase.toUpperCase()];
  // The site sometimes writes the legal form into the slug: "Boulanger-SA".
  const legalWords = base.split(/\s+/).map((w) => w.replace(/\./g, ''))
    .filter((w) => LEGAL.has(fold(w).replace(/[^a-z0-9]/g, ''))).map((w) => w.toUpperCase());
  if (legalWords.length) list.push([titleCase(core).replace(/\s+/g, '-'), ...legalWords].join('-'));
  return [...new Set(list.filter((c) => c && c.trim()))];
}

export default async function lookup(keyword) {
  const started = Date.now();
  const tried = [];
  let problem = null; // first non-404 problem seen; used only if nothing matched
  try {
    const base = String(keyword ?? '').replace(/\s+/g, ' ').trim();
    if (!base) return out('couldnt_check', 'other', [], '', 'empty company name');
    const core = stripLegal(base) || base;
    const wanted = new Set([coreKey(core), coreKey(base)].filter(Boolean));

    for (const c of candidates(core, base)) {
      if (Date.now() - started > START_LIMIT_MS) {
        problem = problem || { reason: 'timeout', url: '', excerpt: 'stopped after 30 s of lookups' };
        break;
      }
      const url = SITE + slug(c) + '/avis';
      tried.push(url);
      let res;
      let body;
      try {
        res = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        body = await res.text();
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        problem = problem || { reason: timedOut ? 'timeout' : 'other', url, excerpt: String(e).slice(0, 200) };
        continue;
      }

      if (res.status === 403 || res.status === 429) {
        return out('couldnt_check', 'blocked', [], url, `HTTP ${res.status} from the company page`);
      }
      if (/captcha|challenge-platform|Just a moment|cf-chl/i.test(body)) {
        return out('couldnt_check', 'blocked', [], url, 'bot check page returned');
      }
      if (res.status === 404) {
        // The site's own error page for a company that has no profile under this spelling.
        if (!/Erreur technique/i.test(body)) {
          problem = problem || { reason: 'layout_changed', url, excerpt: 'HTTP 404 without the site error page' };
        }
        continue;
      }
      if (res.status !== 200) {
        problem = problem || { reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
        continue;
      }

      const m = body.match(/<title>\s*Avis\s+(.+?)\s+-\s+Tous les avis/i)
        || body.match(/sur l(?:&#0?39;|')entreprise\s+(.+?)\s*\|/i);
      if (!m) {
        return out('couldnt_check', 'layout_changed', [], url, 'profile page has no "Avis <name>" title');
      }
      const shown = decode(m[1]);
      if (!wanted.has(coreKey(shown))) continue; // a profile page, but for another company

      return out('found', '', [{ name: shown, profile_url: url }], url,
        decode(body.match(/<title>([^<]*)/i)?.[1] || shown).slice(0, 200));
    }

    if (problem) return out('couldnt_check', problem.reason, [], problem.url || tried[0] || '', problem.excerpt);
    return out('not_found', '', [], tried[0] || '',
      `no Jobijoba company profile for "${base}" (HTTP 404 site error page for ${tried.length} spelling(s): ${tried.join(' , ')})`);
  } catch (e) {
    return out('couldnt_check', 'other', [], tried[0] || '', String(e).slice(0, 200));
  }
}
