export const meta = {
  task: 'FR-boamp.fr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'idweb', 'notice_title', 'buyer', 'published', 'notice_type', 'url'],
  canary: { found: 'SARL DUNEX', not_found: 'Société Zqxvwp Inexistante' },
};

const API = 'https://www.boamp.fr/api/explore/v2.1/catalog/datasets/boamp/records';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;         // largest page the API returns
const MAX_ROWS = 500;     // newest matching notices checked at most
const BUDGET_MS = 40000;  // stop paging early so the whole call stays under 60 s

// Legal forms and filler words dropped before two names are compared.
const LEGAL_PHRASES = /\b(societe a responsabilite limitee|societe par actions simplifiee|societe anonyme|societe civile immobiliere|a responsabilite limitee|societe)\b/g;
const LEGAL_WORDS = new Set(['sarl', 'sas', 'sasu', 'sa', 'eurl', 'snc', 'sci', 'scop', 'selarl', 'selas', 'sca', 'gie', 'ets',
  'ltd', 'llc', 'gmbh', 'inc', 'srl', 'spa', 'slu', 'groupement', 'mandataire', 'cotraitant']);

/** Lower case, no accents, no punctuation. */
function fold(s) {
  return String(s || '')
    .replace(/œ/gi, 'oe').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Comparable form of a company name: case, accents, punctuation and legal form removed. */
function nameKey(s) {
  return fold(s).replace(LEGAL_PHRASES, ' ').split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

function toArray(v) {
  return Array.isArray(v) ? v : (v ? [v] : []);
}

/** One titulaire entry can hold several names: "1er Attributaire: Groupement X (mandataire) / Y". */
function winnerVariants(value) {
  const out = [];
  for (const part of String(value || '').split(/[\/;\n]/)) {
    const cleaned = part
      .replace(/\([^)]*\)/g, ' ')
      .replace(/^\s*\d+\s*\S*\s*attributaire\s*:/i, ' ');
    if (cleaned.trim()) out.push(cleaned.trim());
  }
  return out;
}

/** The raw titulaire entry that names this company, or null. */
function findWinner(row, key) {
  for (const entry of toArray(row.titulaire)) {
    for (const variant of winnerVariants(entry)) {
      if (nameKey(variant) === key) return String(entry).trim();
    }
  }
  return null;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** One request to the BOAMP open-data API. Returns { json } or { error, excerpt }. */
async function getPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { error: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { error: 'http_error', excerpt: `HTTP ${res.status}` };
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (/captcha|verify you are human|access denied|cf-chl/i.test(text)) return { error: 'blocked', excerpt: text.slice(0, 200) };
      return { error: 'layout_changed', excerpt: text.slice(0, 300) };
    }
    if (!json || !Array.isArray(json.results) || typeof json.total_count !== 'number') {
      return { error: 'layout_changed', excerpt: text.slice(0, 300) };
    }
    return { json };
  } catch (err) {
    const timed = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { error: timed ? 'timeout' : 'other', excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const started = Date.now();
    const key = nameKey(keyword);
    const words = key.split(' ').filter(Boolean);
    if (words.length === 0) {
      return fail('other', '', 'no usable company name in the input');
    }

    // Full-text search on the winning bidder field; newest notices first.
    const where = `search(titulaire,"${words.join(' ')}")`;
    const urlFor = (offset) => `${API}?where=${encodeURIComponent(where)}`
      + `&select=${encodeURIComponent('idweb,objet,nomacheteur,titulaire,dateparution,nature_libelle,url_avis')}`
      + `&order_by=${encodeURIComponent('dateparution desc')}&limit=${PAGE}&offset=${offset}`;
    const firstUrl = urlFor(0);

    const matches = [];
    let total = null;
    let scanned = 0;
    let cut = null;

    for (let offset = 0; ; offset += PAGE) {
      if (offset > 0 && offset >= total) break;
      if (offset >= MAX_ROWS) { cut = `only the newest ${MAX_ROWS} notices were checked`; break; }
      if (offset > 0 && Date.now() - started > BUDGET_MS) { cut = 'time budget reached'; break; }

      const page = await getPage(urlFor(offset));
      if (page.error) {
        if (offset === 0 || matches.length === 0) return fail(page.error, firstUrl, page.excerpt);
        cut = `page at row ${offset} failed (${page.error})`;
        break;
      }
      total = page.json.total_count;
      scanned += page.json.results.length;
      for (const row of page.json.results) {
        const winner = findWinner(row, key);
        if (winner !== null) {
          matches.push({
            name: winner,
            idweb: row.idweb || '',
            notice_title: row.objet || '',
            buyer: row.nomacheteur || '',
            published: row.dateparution || '',
            notice_type: row.nature_libelle || '',
            url: row.url_avis || (row.idweb ? `https://www.boamp.fr/pages/avis/?q=idweb:${row.idweb}` : firstUrl),
          });
        }
      }
      if (page.json.results.length === 0) break;
    }

    if (matches.length > 0) {
      const partial = cut ? ` [partial: ${cut}]` : '';
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${matches.length} BOAMP notice(s) name this company as winner. Newest: ${matches[0].notice_title}${partial}`.slice(0, 500),
      };
    }
    if (cut) {
      return fail('other', firstUrl, `no match among ${scanned} of ${total} notices; ${cut}`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 BOAMP notices name "${keyword}" as winner (checked ${scanned} of ${total} search hits)`,
    };
  } catch (err) {
    return fail('other', API, String((err && err.message) || err));
  }
}
