export const meta = {
  task: 'FR-certification.afnor.org',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'standard'],
  canary: { found: 'AMD DECOLLETAGE', not_found: 'Zorglub Inexistante Société' },
};

// AFNOR Certification public certificate search (certificats-attestations.afnor.org).
// The search is a plain form POST (field RaisonSociale), no login, no captcha. It matches a
// substring of the company name as typed, so legal-form words must be removed from the query.
const SEARCH_URL = 'https://certificats-attestations.afnor.org/recherche';
const REFERER = 'https://certificats-attestations.afnor.org/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms at the END of a French company name.
const LEGAL_SINGLE = new Set(['SAS', 'SASU', 'SARL', 'EURL', 'SELARL', 'SELAS', 'SA', 'SAU', 'SCI', 'SNC', 'SCOP', 'SCA', 'SE', 'SEM', 'EI', 'EIRL', 'GIE']);
const LEGAL_MULTI = [
  ['SOCIETE', 'ANONYME'],
  ['SOCIETE', 'PAR', 'ACTIONS', 'SIMPLIFIEE'],
  ['SOCIETE', 'A', 'RESPONSABILITE', 'LIMITEE'],
];

/** Lower-case-free, accent-free, upper-case copy. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/** Remove legal-form words from the end of a token list; never removes everything. */
function stripLegalForm(tokens) {
  let t = tokens.slice();
  let changed = true;
  while (changed && t.length > 1) {
    changed = false;
    for (const phrase of LEGAL_MULTI) {
      const n = phrase.length;
      if (t.length > n && phrase.every((w, i) => t[t.length - n + i] === w)) {
        t = t.slice(0, -n);
        changed = true;
        break;
      }
    }
    if (!changed && LEGAL_SINGLE.has(t[t.length - 1])) {
      t = t.slice(0, -1);
      changed = true;
    }
  }
  return t;
}

/** Comparison key: upper-case letters and digits, legal form removed. */
function nameKey(s) {
  const tokens = fold(s).replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return stripLegalForm(tokens).join('');
}

/** Decode HTML text to plain text. */
function decode(s) {
  const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The company name as the result row shows it, without a trailing qualifier such as " - périmètre ...". */
function mainName(name) {
  return name.split(/\s+-\s+|\s+\(/)[0].trim();
}

/** Result rows of the search page: one per company and referential. */
function parseRows(html) {
  const out = [];
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const nameCell = row.match(/<td[^>]*class="[^"]*t-c-nom[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (!nameCell) continue;
    const h3 = nameCell[1].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h3) continue;
    const name = decode(h3[1]);
    const afterName = nameCell[1].slice(nameCell[1].indexOf(h3[0]) + h3[0].length);
    const address = decode(afterName.split(/<div|<span/i)[0]);
    const std = row.match(/<td[^>]*class="[^"]*t-c-infos[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const standard = decode(std ? std[1] : '');
    if (name) out.push({ name, address, standard });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    // Keep the typed words (accents included) minus any trailing legal form.
    const pairs = String(keyword || '').trim().split(/\s+/)
      .map((orig) => ({ orig, key: fold(orig).replace(/[^A-Z0-9]/g, '') }))
      .filter((p) => p.key);
    if (pairs.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_URL, excerpt: 'empty company name' };
    }
    const keep = stripLegalForm(pairs.map((p) => p.key)).length;
    const term = pairs.slice(0, keep).map((p) => p.orig).join(' ').replace(/[\s.,;:'"-]+$/, '');
    const key = nameKey(keyword);

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': REFERER,
        'Connection': 'close',
      },
      body: new URLSearchParams({ Page: '1', RaisonSociale: term }).toString(),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const marker = html.search(/R\S{1,3}sultats de la recherche/i);
    if (marker < 0) {
      const blocked = /captcha|challenge-platform|cf-chl|access denied/i.test(html);
      return {
        status: 'couldnt_check',
        reason: blocked ? 'blocked' : 'layout_changed',
        records: [],
        source_url: SEARCH_URL,
        excerpt: decode(html).slice(0, 300),
      };
    }

    const declared = Number((decode(html.slice(marker, marker + 300)).match(/(\d+)/) || [])[1] || 0);
    const rows = parseRows(html);
    if (declared > 0 && rows.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `page says ${declared} results but no result row could be read`,
      };
    }
    const truncated = /limit\S*[^<]{0,12}15 mais/i.test(html);

    const matches = rows.filter((r) => nameKey(mainName(r.name)) === key);
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({ name: r.name, address: r.address, standard: r.standard })),
        source_url: SEARCH_URL,
        excerpt: `search "${term}": ${matches.length} matching row(s)` + (truncated ? ' (list capped at 15, others may exist)' : ''),
      };
    }
    if (truncated) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `search "${term}" returns more than ${rows.length} rows and the name is not among them; the site caps results at 15`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SEARCH_URL,
      excerpt: `search "${term}": ${rows.length} row(s), none is "${keyword}"`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: SEARCH_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
