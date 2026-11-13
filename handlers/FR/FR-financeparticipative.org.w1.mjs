export const meta = {
  task: 'FR-financeparticipative.org',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'financial_services', 'outbound_passports', 'country_of_registration', 'as_of', 'source_list'],
  canary: { found: 'Enerfip', not_found: 'Boulangerie Lumière Dorée SARL' },
};

const PAGE = 'https://financeparticipative.org/agrement-psfp-etat-des-lieux/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

function cellText(cell) {
  return decode(cell.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Compare names without case, accents, punctuation or a trailing legal form (SAS, SARL, ...).
const LEGAL_SUFFIX = /\s(sas|sasu|sarl|eurl|sa|sci|scop|sl|srl|gmbh|ltd|bv|ag|plc)$/;
function normalize(str) {
  let s = (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,;:'"’()\-&]/g, ' ').replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(LEGAL_SUFFIX, ''); } while (s !== prev);
  return s.replace(/[^a-z0-9]/g, '');
}

function tables(html) {
  return html.match(/<table[\s\S]*?<\/table>/gi) || [];
}

function rowsOf(table) {
  return (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((tr) =>
    (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(cellText)
  );
}

function cleanPage(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const kwNorm = normalize(kw);
  if (!kwNorm) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
  }

  let res;
  try {
    res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PAGE, excerpt: String(err?.message || err).slice(0, 300) };
  }

  if (res.status === 403 || res.status === 429) {
    return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
  }

  let html;
  try {
    html = await res.text();
  } catch (err) {
    return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: PAGE, excerpt: String(err?.message || err).slice(0, 300) };
  }

  const frTable = [];
  const foreignTable = [];
  for (const t of tables(html)) {
    const rows = rowsOf(t);
    if (!rows.length) continue;
    const header = rows[0].join(' | ');
    if (/^Plateforme \| Services financiers/i.test(header)) frTable.push(...rows.slice(1));
    else if (/^Plateforme \| Pays d.{1,3}immatriculation/i.test(header)) foreignTable.push(...rows.slice(1));
  }

  // The snapshot date is the "au <date>" sentence that follows "état des lieux" in the body text.
  const text = cleanPage(html);
  let asOf = 'date not stated on the page';
  for (const m of text.matchAll(/au (\d{1,2} \p{L}+ \d{4})/gu)) {
    if (text.slice(Math.max(0, m.index - 160), m.index).includes('état des lieux')) { asOf = m[1]; break; }
  }

  if (frTable.length === 0) {
    const looksBlocked = /captcha|cf-challenge|Just a moment|Attention Required|access denied/i.test(html);
    return {
      status: 'couldnt_check',
      reason: looksBlocked ? 'blocked' : 'layout_changed',
      records: [],
      source_url: PAGE,
      excerpt: text.slice(0, 300),
    };
  }

  const records = [];
  const matchedRows = [];
  for (const r of frTable) {
    if (r.length >= 3 && normalize(r[0]) === kwNorm) {
      records.push({ list: 'French platforms with PSFP status', name: r[0], financial_services: r[1], outbound_passports: r[2], country_of_registration: 'France', as_of: asOf, source_list: 'PSFP status table' });
      matchedRows.push(r.join(' | '));
    }
  }
  for (const r of foreignTable) {
    if (r.length >= 2 && normalize(r[0]) === kwNorm) {
      records.push({ list: 'Foreign platforms wishing to operate in France', name: r[0], financial_services: '', outbound_passports: '', country_of_registration: r[1], as_of: asOf, source_list: 'foreign platforms table' });
      matchedRows.push(r.join(' | '));
    }
  }

  const counted = `${frTable.length} French and ${foreignTable.length} foreign platforms`;

  if (records.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `No match for "${kw}" among ${counted} on the page (as of ${asOf}).`,
    };
  }

  return {
    status: 'found',
    reason: '',
    records,
    source_url: PAGE,
    excerpt: `${matchedRows.join(' || ')} (as of ${asOf})`.slice(0, 500),
  };
}
