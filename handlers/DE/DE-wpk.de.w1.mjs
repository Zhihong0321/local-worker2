export const meta = { task: 'DE-wpk.de', want: 'w1', tier: 2, method: 'post', pdf: false, input: 'company name',
  fields: ['name', 'registernummer', 'status', 'classification', 'street', 'postal_code', 'city'],
  canary: { found: 'KPMG AG Wirtschaftsprüfungsgesellschaft', not_found: 'Phantasie Wirtschaftsprüfung Quaxenbach GmbH' } };

const SEARCH_URL = 'https://www.wpk.de/berufsregister/backend/search';
const PAGE_URL = 'https://www.wpk.de/berufsregister/?lang=de';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms and register descriptions that are dropped before two names are compared (German register).
const LEGAL = new Set(['gmbh', 'ag', 'kg', 'kgaa', 'co', 'mbh', 'ug', 'se', 'ohg', 'gbr', 'partg', 'partgmbb', 'ev',
  'und', 'and', 'mit', 'beschraenkter', 'haftung', 'gesellschaft', 'wirtschaftspruefungsgesellschaft',
  'steuerberatungsgesellschaft', 'zweigniederlassung', 'rechtsanwaltsgesellschaft', 'limited', 'ltd']);

/** Lower case, German umlauts and accents folded, to ASCII letters and digits. */
function fold(s) {
  return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Normalised company core: no case, punctuation, branch brackets or legal form. Two names match when cores are equal. */
function coreKey(name) {
  const cleaned = fold(String(name || '').replace(/\(.*?\)/g, ' ').replace(/"/g, ' ').replace(/&/g, ' '))
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return cleaned.split(' ').filter((t) => t && !LEGAL.has(t)).join(' ');
}

/** The keyword as sent to the register's name search: trailing legal form removed, spelling kept (search is substring). */
function searchTerm(keyword) {
  const words = String(keyword || '').replace(/\(.*?\)/g, ' ').replace(/"/g, ' ').split(/\s+/).filter(Boolean);
  const isLegalWord = (w) => w === '&' || LEGAL.has(fold(w).replace(/[^a-z0-9]/g, ''));
  while (words.length > 1 && isLegalWord(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const term = searchTerm(keyword);
    const wanted = coreKey(keyword);
    if (!term || !wanted) return fail('other', PAGE_URL, 'name has no words left after removing the legal form');

    // The register's own search form, sent the way its page sends it (multipart form, Germany, all types).
    const form = new FormData();
    form.append('registernummer', '');
    form.append('name', term);
    form.append('vorname', '');
    form.append('ort', '');
    form.append('plz', '');
    form.append('type', '1');
    form.append('country', '004');

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      body: form,
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('blocked', PAGE_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', PAGE_URL, `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|access denied|zugriff verweigert/i.test(text.slice(0, 2000))) return fail('blocked', PAGE_URL, text.slice(0, 300));

    let rows;
    try { rows = JSON.parse(text); } catch { return fail('layout_changed', PAGE_URL, text.slice(0, 300)); }
    if (!Array.isArray(rows)) return fail('layout_changed', PAGE_URL, text.slice(0, 300));

    // Company rows only (natural persons are dropped); keep those whose normalised name equals the keyword's.
    const companies = rows.filter((r) => r && r.istPerson !== true && typeof r.name === 'string');
    const matches = companies.filter((r) => coreKey(r.name) === wanted);

    if (matches.length === 0) {
      const near = companies.slice(0, 5).map((r) => r.name).join(' | ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: companies.length === 0
          ? `0 results for "${term}" (country Germany)`
          : `${companies.length} results for "${term}", none with the same name. Nearest: ${near}`.slice(0, 500),
      };
    }

    const records = matches.map((r) => ({
      name: r.name,
      registernummer: String(r.registernummer ?? ''),
      status: r.statusTxt || '',
      classification: r.klassifizierungBRO || '',
      street: r.strasse || '',
      postal_code: r.plz || '',
      city: r.ort || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: `https://www.wpk.de/berufsregister/?registernummer=${encodeURIComponent(records[0].registernummer)}&lang=de`,
      excerpt: records.map((r) => `${r.name} | ${r.registernummer} | ${r.status} | ${r.postal_code} ${r.city}`).join('\n').slice(0, 500),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, PAGE_URL, String(err?.message || err));
  }
}
