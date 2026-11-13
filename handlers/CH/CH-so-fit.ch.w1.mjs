export const meta = {
  task: 'CH-so-fit.ch',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'canton', 'type_code', 'type', 'site_id'],
  canary: { found: 'Ideal Gestion SA', not_found: 'Fiduciaire Inexistante Lucerne SA' },
};

// The site's own search page (https://so-fit.ch/recherche/) calls this JSON endpoint with ?q=<text>.
// It answers {"<id>": [name, canton, type]} (or [] when nothing matches). Matching is a case-insensitive
// substring search on the name, and it is accent-sensitive, so the query must keep the typed accents.
const SEARCH = 'https://so-fit.ch/wp-json/search?q=';
const REFERER = 'https://so-fit.ch/recherche/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms, dropped from the end of a name before the search and before comparing.
const LEGAL_FORMS = new Set(['sa', 'sarl', 'rl', 'ag', 'gmbh', 'ltd', 'limited', 'llc', 'inc', 'corp', 'co', 'plc',
  'sas', 'sagl', 'snc', 'srl', 'bv', 'sl', 'ltda', 'bhd', 'pte', 'kg', 'llp', 'lp']);
// The site's own legend: OS = Organisme de surveillance, OAR = Organisme d'autorégulation.
const TYPE_LABELS = { OS: 'Organisme de surveillance (OS)', OAR: "Organisme d'autorégulation (OAR)" };

/** Lower case, no accents, letters and digits only. "&" becomes "and". */
function fold(word) {
  return String(word || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

/** The name's words without parenthesised notes and without trailing legal-form words. */
function coreWords(name) {
  const cleaned = String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bS\s*\.\s*A\b\.?/gi, 'SA')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned ? cleaned.split(' ') : [];
  while (words.length > 1 && LEGAL_FORMS.has(fold(words[words.length - 1]))) words.pop();
  return words;
}

function nameKey(name) {
  return coreWords(name).map(fold).join('');
}

/** One search request. Returns { url, rows } or { url, fail, excerpt }. Never throws. */
async function query(q) {
  const url = SEARCH + encodeURIComponent(q);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': REFERER,
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { url, fail: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { url, fail: 'http_error', excerpt: `HTTP ${res.status}` };

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (/captcha|challenge|cloudflare|access denied/i.test(text.slice(0, 3000))) {
        return { url, fail: 'blocked', excerpt: text.slice(0, 300) };
      }
      return { url, fail: 'layout_changed', excerpt: text.slice(0, 300) };
    }

    let entries;
    if (Array.isArray(data)) {
      if (data.length) return { url, fail: 'layout_changed', excerpt: JSON.stringify(data).slice(0, 300) };
      entries = [];
    } else if (data && typeof data === 'object') {
      entries = Object.entries(data);
    } else {
      return { url, fail: 'layout_changed', excerpt: text.slice(0, 300) };
    }

    const rows = [];
    for (const [id, v] of entries) {
      if (!Array.isArray(v) || typeof v[0] !== 'string' || typeof v[1] !== 'string' || typeof v[2] !== 'string') {
        return { url, fail: 'layout_changed', excerpt: JSON.stringify(data).slice(0, 300) };
      }
      rows.push({ site_id: id, name: v[0].trim(), canton: v[1].trim(), type_code: v[2].trim() });
    }
    return { url, rows };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, fail: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }
}

async function run(keyword) {
  try {
    const words = coreWords(keyword);
    const key = words.map(fold).join('');
    const q = words.join(' ');
    if (key.length < 3) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH + encodeURIComponent(q),
        excerpt: 'the name is too short for the site search (needs at least 3 letters without the legal form)' };
    }

    // 1) The name as typed, without its legal form.
    const first = await query(q);
    if (first.fail) return { status: 'couldnt_check', reason: first.fail, records: [], source_url: first.url, excerpt: first.excerpt };
    let hits = first.rows.filter((r) => nameKey(r.name) === key);
    let used = first;
    let secondNote = '';

    // 2) If the first search has no exact match, search the longest word of the name instead. The site search
    //    cannot match an accent-less word against an accented name, so this catches "Rhone" for "Rhône".
    //    Matching is still on the full normalised name, so no similar name is accepted.
    if (!hits.length && words.length > 1) {
      const longest = words.filter((w) => fold(w).length >= 3)
        .sort((a, b) => fold(b).length - fold(a).length)[0];
      if (longest) {
        const second = await query(longest);
        if (second.fail) return { status: 'couldnt_check', reason: second.fail, records: [], source_url: second.url, excerpt: second.excerpt };
        hits = second.rows.filter((r) => nameKey(r.name) === key);
        used = second;
        secondNote = ` Second search "${longest}" returned ${second.rows.length} entries.`;
      }
    }

    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits.map((r) => ({
          name: r.name,
          canton: r.canton,
          type_code: r.type_code,
          type: TYPE_LABELS[r.type_code] || r.type_code,
          site_id: r.site_id,
        })),
        source_url: used.url,
        excerpt: JSON.stringify(hits).slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: first.url,
      excerpt: `The site search for "${q}" returned ${first.rows.length} entries, none with the name "${q}".${secondNote}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SEARCH + encodeURIComponent(String(keyword || '')),
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Give the HTTP sockets a moment to settle before the process exits. Exiting straight after the last fetch
  // trips a libuv assertion on Windows (exit code 127), which would make the harness see a crash.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}
