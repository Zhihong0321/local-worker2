export const meta = { task: 'DE-provenexpert.com', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'profile_url'],
  canary: { found: 'Europa-Park Rust', not_found: 'Zxqvbnm Unbekannte Firma GmbH' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.provenexpert.com/';

// German legal-form endings, stripped before comparing names (longest first).
const LEGAL_FORMS = /\s*(gmbh\s*&\s*co\.?\s*kgaa?|gmbh\s*&\s*co\.?\s*kg|co\.?\s*kgaa?|gmbh|mbh|ag|kgaa?|ug\s*\(haftungsbeschränkt\)|ug|ohg|gbr|e\.?\s*k\.?|e\.?\s*v\.?|se|ltd\.?)\s*\.?\s*$/i;

function transliterate(str) {
  return (str || '')
    .replace(/ä/gi, (m) => (m === 'Ä' ? 'Ae' : 'ae'))
    .replace(/ö/gi, (m) => (m === 'Ö' ? 'Oe' : 'oe'))
    .replace(/ü/gi, (m) => (m === 'Ü' ? 'Ue' : 'ue'))
    .replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function stripLegal(name) {
  let s = (name || '').trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(LEGAL_FORMS, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function normalize(str) {
  return transliterate(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Profile slug as ProvenExpert writes it: lower case, umlauts spelled out, runs of other characters become "-". */
function slugify(str) {
  return transliterate(str).toLowerCase().replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = (keyword || '').trim();
    if (!input) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    // Candidate profile slugs: the full name, then the name without its legal form (ProvenExpert often drops it).
    const bare = stripLegal(input);
    const candidates = [...new Set([slugify(input), slugify(bare)].filter(Boolean))];

    let sawNotFound = false;
    let lastProblem = null;

    for (const slug of candidates) {
      const url = `${BASE}${slug}/`;
      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9' },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        lastProblem = { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url, excerpt: String(err?.message || err).slice(0, 300) };
        continue;
      }

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: res.url || url, excerpt: `HTTP ${res.status}` };
      }

      // Not on the site: ProvenExpert answers an unknown profile with 410 "Page not found" (404 is treated the same way).
      if (res.status === 410 || res.status === 404) {
        const body = await res.text();
        if (/provenexpert/i.test(body)) {
          sawNotFound = true;
          continue;
        }
        lastProblem = { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: `HTTP ${res.status}, page is not a ProvenExpert page: ` + cleanText(body).slice(0, 200) };
        continue;
      }

      if (!res.ok) {
        lastProblem = { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
        continue;
      }

      const html = await res.text();
      const finalUrl = res.url || url;

      if (/captcha|cf-challenge|cf-chl|Just a moment|Attention Required/i.test(html.slice(0, 20000))) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: finalUrl, excerpt: 'bot check page' };
      }

      const h1 = html.match(/<h1[^>]*class="[^"]*profileName[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
      if (!h1) {
        lastProblem = { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: finalUrl, excerpt: cleanText(html).slice(0, 300) };
        continue;
      }
      const siteName = decodeEntities(cleanText(h1[1]));

      // Compare normalised names (case, punctuation, umlauts, legal form) before calling it found.
      const sameName = normalize(siteName) === normalize(input) ||
        normalize(stripLegal(siteName)) === normalize(bare) ||
        (normalize(stripLegal(siteName)) !== '' && normalize(stripLegal(siteName)) === normalize(stripLegal(input)));

      if (!sameName) {
        // A different company that happens to share the slug: not a match, keep looking.
        sawNotFound = true;
        continue;
      }

      return {
        status: 'found',
        reason: '',
        records: [{ name: siteName, profile_url: finalUrl }],
        source_url: finalUrl,
        excerpt: cleanText(html).slice(0, 500),
      };
    }

    // Any candidate that could not be checked means the answer is unknown, never not_found.
    if (lastProblem) return lastProblem;

    if (sawNotFound) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: `${BASE}${candidates[0]}/`,
        excerpt: `No ProvenExpert profile at ${candidates.map((s) => `/${s}/`).join(' or ')} (HTTP 410 Page not found)`,
      };
    }

    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no candidate checked' };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
