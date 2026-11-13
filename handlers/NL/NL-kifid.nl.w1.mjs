export const meta = { task: 'NL-kifid.nl', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'kifid_number', 'afm_number', 'category', 'connection_status', 'address', 'connect_date', 'disconnect_date', 'disconnect_reason', 'tradenames'],
  canary: { found: 'Coöperatieve Rabobank U.A.', not_found: 'Qwrtzkl Beheer B.V.' } };

// Kifid's "Is mijn financiële dienstverlener aangesloten?" register (the same JSON API the site's search page calls).
const BASE = 'https://www.kifid.nl/api/FinancialServiceProvider/Search/';
const REFERER = 'https://www.kifid.nl/dienstverlenersregister/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const LEGAL_FORMS = new Set(['bv', 'nv', 'ua', 'vof', 'cv', 'bvba', 'stichting']);

/** Normalised name: no accents, no case, no punctuation, no legal form (B.V., N.V., U.A. ...). */
function norm(s) {
  const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/&/g, ' en ').replace(/[^a-z0-9]+/g, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_FORMS.has(w)).join(' ');
}

function day(s) {
  return typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : '';
}

function toRecord(x, matchedOn) {
  return {
    name: x.name || '',
    kifid_number: x.kifidNumber || '',
    afm_number: x.afmNumber && x.afmNumber > 0 ? String(x.afmNumber) : '',
    category: x.category || '',
    connection_status: x.connectionStatus || '',
    address: x.address || '',
    connect_date: day(x.connectDate),
    disconnect_date: day(x.disconnectDate),
    disconnect_reason: x.disconnectReason || '',
    tradenames: (Array.isArray(x.tradename) ? x.tradename : []).map((t) => t.text).filter(Boolean),
    matched_on: matchedOn,
    site_id: x.id ?? null,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let lastUrl = BASE;
  try {
    const kw = norm(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    const matches = [];
    let scanned = 0;
    let total = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      lastUrl = `${BASE}?searchTerm=${encodeURIComponent(keyword)}&sort=&page=${page}&pageSize=${PAGE_SIZE}`;
      const res = await fetch(lastUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': REFERER },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: lastUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: lastUrl, excerpt: `HTTP ${res.status}` };
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        if (/captcha|just a moment|cf-chl|access denied/i.test(text)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: lastUrl, excerpt: text.slice(0, 200) };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: lastUrl, excerpt: text.slice(0, 300) };
      }

      if (!data || typeof data !== 'object') {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: lastUrl, excerpt: text.slice(0, 300) };
      }
      if (data.isError === true) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl, excerpt: `site error: ${String(data.message || '').slice(0, 300)}` };
      }

      const list = Array.isArray(data.searchList) ? data.searchList : (data.totalItems === 0 ? [] : null);
      if (!list) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: lastUrl, excerpt: text.slice(0, 300) };
      }
      if (typeof data.totalItems === 'number') total = data.totalItems;
      scanned += list.length;

      for (const x of list) {
        if (norm(x.name) === kw) {
          matches.push(toRecord(x, 'name'));
        } else if ((Array.isArray(x.tradename) ? x.tradename : []).some((t) => norm(t.text) === kw)) {
          matches.push(toRecord(x, 'tradename'));
        }
      }
      if (matches.length > 0) break;
      if (list.length < PAGE_SIZE) break;
      if (total !== null && scanned >= total) break;
    }

    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: lastUrl,
        excerpt: `${first.name} | Kifid ${first.kifid_number} | ${first.connection_status}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `No Kifid register entry named "${keyword}" among ${scanned} of ${total ?? '?'} search results`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
