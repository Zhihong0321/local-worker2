export const meta = {
  task: 'DE-experteer.de',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'industry', 'headquarters', 'employees', 'website'],
  canary: { found: 'BMW Group', not_found: 'Zwergenhaus Glockenspiel GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.experteer.de/career/company/';
const NOT_FOUND_MARK = 'NEXT_HTTP_ERROR_FALLBACK;404';

// Legal forms, lower-case, no dots/ampersands. Stripped from the end of the name only.
const LEGAL_FORMS = new Set([
  'gmbh', 'mbh', 'ag', 'se', 'kg', 'kgaa', 'co', 'ohg', 'gbr', 'ug', 'ev', 'eg', 'e', 'k',
  'haftungsbeschraenkt', 'haftungsbeschrankt', 'ltd', 'llc', 'inc', 'plc', 'corp', 'sa', 'sas',
  'sarl', 'bv', 'nv', 'spa', 'srl', 'ab', 'oy', 'as', 'aps', 'kft', 'sro',
]);

function decodeEntities(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&uuml;/gi, 'ü').replace(/&ouml;/gi, 'ö').replace(/&auml;/gi, 'ä').replace(/&szlig;/gi, 'ß')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lower-case, umlauts spelled out (ä->ae ...), accents removed, only a-z0-9 kept.
function fold(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Remove trailing legal-form words, e.g. "ACME Trading GmbH & Co. KG" -> "ACME Trading".
function stripLegal(name) {
  const words = (name || '').replace(/&/g, ' ').replace(/\./g, '').split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

// Profile slug as the site writes it: "BMW Group" -> bmw_group, "Knorr-Bremse" -> knorrbremse,
// "Würth" -> wuerth, "Procter & Gamble" -> procter_gamble. Words are joined with '_' (joiner '_') or with
// nothing (joiner ''), because the site is not consistent about it. umlaut 'ue' spells ä/ö/ü out; 'plain' drops the dots.
function slugFor(name, umlaut, joiner) {
  let s = name.toLowerCase();
  s = umlaut === 'ue'
    ? s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    : s.replace(/ß/g, 'ss');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean).join(joiner);
  return s;
}

function field(html, label) {
  const m = html.match(new RegExp(`<h3>\\s*${label}\\s*</h3>\\s*(?:<p>|<a[^>]*>)([\\s\\S]*?)(?:</p>|</a>)`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function blockedBody(html) {
  return /captcha|cf-challenge|just a moment|access denied/i.test(html.slice(0, 20000));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const typed = String(keyword || '').trim();
  const core = stripLegal(typed) || typed;
  const wanted = fold(stripLegal(typed) || typed);
  const urls = [...new Set(
    ['_', ''].flatMap((joiner) => ['ue', 'plain'].map((umlaut) => BASE + slugFor(core, umlaut, joiner))),
  )];
  let lastUrl = urls[0];
  let sawOtherProfile = '';
  const started = Date.now();

  try {
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    for (const url of urls) {
      lastUrl = url;
      const left = 50000 - (Date.now() - started); // the whole call must finish in under 60 s
      if (left < 3000) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: url, excerpt: 'spelling variants not all tried within 50 s' };
      }
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
        signal: AbortSignal.timeout(Math.min(25000, left)),
      });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();

      if (res.status === 404) {
        // Node 24 on Windows aborts (exit 127) if the process exits right after a 404 body is read; a short
        // pause lets the socket settle first. It costs 0.5 s and only runs on the not-found path.
        await new Promise((done) => setTimeout(done, 500));
        if (html.includes(NOT_FOUND_MARK)) continue; // the site's own "no such company" page: try the next spelling
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: 'HTTP 404 without the company-not-found page' };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (blockedBody(html) && !/<h1[\s>]/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
      }

      const h1 = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
      if (!h1) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: html.slice(0, 300) };
      }

      if (fold(stripLegal(h1)) === wanted) {
        const record = {
          name: h1,
          industry: field(html, 'Branche'),
          headquarters: field(html, 'Hauptsitz'),
          employees: field(html, 'Mitarbeiter'),
          website: field(html, 'Website'),
        };
        return {
          status: 'found',
          reason: '',
          records: [record],
          source_url: url,
          excerpt: `${record.name} | ${record.industry} | ${record.headquarters}`.slice(0, 500),
        };
      }
      // A profile exists under another name (e.g. a different company with a similar slug): not this company.
      sawOtherProfile = h1;
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: sawOtherProfile
        ? `Profile page "${sawOtherProfile}" is not the company searched; no profile for "${typed}" (HTTP 404 for ${urls.join(', ')})`
        : `No Experteer company profile for "${typed}" (HTTP 404 for ${urls.join(', ')})`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
