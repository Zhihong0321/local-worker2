export const meta = {
  task: 'NL-belastingdienst.nl',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'alias', 'rsin', 'dossier_number', 'start_date', 'city', 'website'],
  canary: { found: 'STICHTING GREENPEACE NEDERLAND', not_found: 'Stichting Qwerzxy Onbekend Fonds' },
};

const SEARCH_URL = 'https://portaal.belastingdienst.nl/anbi-service/api/search';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Dutch legal-form words that are not part of the name itself.
const LEGAL_FORMS = new Set(['stichting', 'vereniging', 'bv', 'nv', 'cooperatie', 'coperatie', 'ua', 'vof']);

function tokens(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Name without legal form, as one comparable key. */
function nameKey(str) {
  const core = tokens(str).filter((t) => !LEGAL_FORMS.has(t));
  return core.join('');
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Windows + Node 24: calling process.exit() straight after a fetch can abort with a libuv assertion (exit 127).
  // A short pause lets the socket close first; the answer is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return answer;
}

async function search(keyword) {
  try {
    const typed = String(keyword || '').trim();
    if (!typed) return couldnt('other', SEARCH_URL, 'empty company name');

    // The site matches words loosely; search with the name without legal form, then compare strictly below.
    const searchTerm = tokens(typed).filter((t) => !LEGAL_FORMS.has(t)).join(' ') || typed;
    const body = JSON.stringify({
      search: [
        { zoekWaarde: searchTerm, zoekOpdrachtType: 'INSTELLINGSNAAM' },
        { zoekWaarde: '', zoekOpdrachtType: 'VESTIGINGSPLAATS' },
      ],
    });

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json;charset=utf-8',
        'Accept': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return couldnt('blocked', SEARCH_URL, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', SEARCH_URL, `HTTP ${res.status}`);

    const text = await res.text();
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      return couldnt('layout_changed', SEARCH_URL, text.slice(0, 300));
    }
    if (!Array.isArray(list)) return couldnt('layout_changed', SEARCH_URL, text.slice(0, 300));

    const wanted = nameKey(typed);
    const matches = list.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      return (wanted && nameKey(item.naam) === wanted) || (wanted && item.aliasNaam && nameKey(item.aliasNaam) === wanted);
    });

    if (matches.length === 0) {
      const nearest = list
        .slice(0, 3)
        .map((item) => String(item?.naam || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `0 matching ANBI entries for "${typed}" (${list.length} loosely related: ${nearest})`,
      };
    }

    const records = matches.map((item) => ({
      name: String(item.naam || '').replace(/\s+/g, ' ').trim(),
      alias: item.aliasNaam ? String(item.aliasNaam).trim() : '',
      rsin: item.fiscaalNummer != null ? String(item.fiscaalNummer) : '',
      dossier_number: item.dossierNummer != null ? String(item.dossierNummer) : '',
      start_date: item.ingangsDatum || '',
      city: String(item.vestigingsPlaats || '').replace(/\s+/g, ' ').trim(),
      website: item.webSite || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: SEARCH_URL,
      excerpt: records.map((r) => `${r.name} | RSIN ${r.rsin} | ${r.city} | since ${r.start_date}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timedOut ? 'timeout' : 'other', SEARCH_URL, String(err?.message || err));
  }
}
