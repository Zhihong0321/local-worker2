export const meta = {
  task: 'FR-regafi.fr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'reference_id', 'entity_type', 'activity', 'authorisation', 'lei', 'trade_names', 'sigle', 'city', 'postal_code', 'country', 'being_retired'],
  canary: { found: 'Axa banque', not_found: 'Société Fantôme Zéphyr Holding SAS' },
};

// REGAFI (ACPR) publishes its register through an open-data (Explore v2.1) JSON API on the same site.
// Dataset prd-jdd-recherche is the search dataset for banks and insurers (entity_type = Banque / Assurance).
const BASE = 'https://www.regafi.fr/api/explore/v2.1/catalog/datasets/prd-jdd-recherche/records';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;        // the API returns at most 100 records per call
const MAX_MATCHES = 500; // more search hits than this: too broad to check every one, so say couldnt_check

// Trailing legal forms, longest first. They are removed on both sides before comparing names.
const LEGAL_SUFFIXES = [
  'societe par actions simplifiee', 'societe anonyme', 'societe a responsabilite limitee',
  'societe en commandite par actions', 'societe civile immobiliere', 'societe en nom collectif',
  'sasu', 'sas', 'sarl', 'eurl', 'snc', 'scs', 'sca', 'sci', 'sce', 'sa', 'se',
  'ltd', 'plc', 'llc', 'inc', 'gmbh', 'bv', 'nv', 'ag', 'srl', 'spa',
];

class Failure extends Error {
  constructor(reason, excerpt, url) {
    super(excerpt);
    this.reason = reason;
    this.excerpt = excerpt;
    this.url = url;
  }
}

/** Lower case, no accents, no punctuation: "Axa Banque, S.A." -> "axa banque sa" */
function fold(str) {
  return String(str || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The name without its trailing legal form: "Axa banque SA" -> "axa banque" */
function coreName(str) {
  let tokens = fold(str).split(' ').filter(Boolean);
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const parts = suffix.split(' ');
      if (tokens.length > parts.length && tokens.slice(-parts.length).join(' ') === suffix) {
        tokens = tokens.slice(0, -parts.length);
        changed = true;
        break;
      }
    }
  }
  return tokens.join(' ');
}

function searchUrl(core, offset) {
  const u = new URL(BASE);
  u.searchParams.set('where', `search(denomination,"${core}")`);
  u.searchParams.set('limit', String(PAGE));
  u.searchParams.set('offset', String(offset));
  return u.toString();
}

async function getJson(url) {
  // Same 25 s cap as AbortSignal.timeout(25000), but the timer is cleared when the call ends.
  // AbortSignal.timeout leaves a pending timer, and Node 24 on Windows then aborts (exit 127)
  // when the runner calls process.exit.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: ctl.signal,
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new Failure(timedOut ? 'timeout' : 'other', String(err?.message || err), url);
    }
    if (res.status === 403 || res.status === 429) throw new Failure('blocked', `HTTP ${res.status}`, url);
    if (!res.ok) throw new Failure('http_error', `HTTP ${res.status}`, url);

    let body;
    try {
      body = await res.json();
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (timedOut) throw new Failure('timeout', 'body read timed out', url);
      throw new Failure('layout_changed', 'response is not JSON', url);
    }
    if (!body || !Array.isArray(body.results) || typeof body.total_count !== 'number') {
      throw new Failure('layout_changed', 'JSON has no results/total_count', url);
    }
    return body;
  } finally {
    clearTimeout(timer);
    // Let the socket finish closing before the call returns: on Node 24 for Windows, a process.exit()
    // right after the body is read can abort the process (exit 127) while the socket is still closing.
    await new Promise((r) => setTimeout(r, 100));
  }
}

const text = (v) => (Array.isArray(v) ? v.join(', ') : (v ?? null));

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = '';
  try {
    const core = coreName(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    url = searchUrl(core, 0);
    const first = await getJson(url);
    let rows = first.results;
    const total = first.total_count;

    if (total > MAX_MATCHES) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: url,
        excerpt: `${total} search hits for "${core}", too many to check every one`,
      };
    }
    if (total > rows.length) {
      const offsets = [];
      for (let off = PAGE; off < total; off += PAGE) offsets.push(off);
      const pages = await Promise.all(offsets.map((off) => getJson(searchUrl(core, off))));
      for (const page of pages) rows = rows.concat(page.results);
    }

    const matches = rows.filter((r) => typeof r.denomination === 'string' && coreName(r.denomination) === core);

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `0 exact name matches for "${core}" among ${total} search results`,
      };
    }

    const records = matches.map((r) => ({
      name: r.denomination,
      company_id: r.company_id ?? null,
      reference_id: r.reference_id ?? null,
      entity_type: r.entity_type ?? null,
      activity: text(r.activity),
      authorisation: text(r.nature_autorisation),
      lei: r.lei ?? null,
      trade_names: text(r.nom_commerciaux),
      sigle: r.sigle ?? null,
      city: r.ville ?? null,
      postal_code: r.code_postal ?? null,
      country: r.country ?? null,
      being_retired: r.is_being_retired ?? null,
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: records
        .map((r) => `${r.name} | ${r.entity_type} | ${r.authorisation} | ${r.city}`)
        .join(' ; ')
        .slice(0, 500),
    };
  } catch (err) {
    if (err instanceof Failure) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url || url, excerpt: String(err.excerpt).slice(0, 500) };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: url, excerpt: String(err?.message || err).slice(0, 500) };
  }
}
