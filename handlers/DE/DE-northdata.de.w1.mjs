export const meta = {
  task: 'DE-northdata.de',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'city', 'register', 'url'],
  canary: { found: 'Siemens AG', not_found: 'Zwqxjvkfm Lebensmittelhandel GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['gmbh', 'ag', 'ug', 'kg', 'kgaa', 'ohg', 'gbr', 'se', 'ev', 'eg', 'co', 'und', 'mbh', 'haftungsbeschrankt', 'ltd', 'limited']);
// The site's suggest list holds about 15 entries at most. A list this long with no exact match may be cut off,
// so absence cannot be proven and the answer is couldnt_check, not not_found.
const CUT_OFF_SIZE = 10;

/** Case, umlauts, accents, punctuation and spacing do not count. */
function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s) { return fold(s).split(' ').filter(Boolean); }
function coreOf(s) { return tokens(s).filter((t) => !LEGAL_FORMS.has(t)).join(' '); }
function hasLegalForm(s) { return tokens(s).some((t) => LEGAL_FORMS.has(t)); }

/** The register entry (e.g. "HRB 6684") is the last part of the company's page address; "_c..." means none. */
function registerFrom(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return last && !last.startsWith('_') ? last : '';
  } catch {
    return '';
  }
}

function snippet(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const sourceUrl = `https://www.northdata.de/suggest.json?query=${encodeURIComponent(name)}&countries=DE`;
  const fail = (status, reason, excerpt) => ({ status, reason, records: [], source_url: sourceUrl, excerpt });
  try {
    if (!name) return fail('couldnt_check', 'other', 'empty company name');

    const res = await fetch(sourceUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        'Referer': 'https://www.northdata.de/',
      },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();

    if (res.status === 403 || res.status === 429) {
      return fail('couldnt_check', 'blocked', `HTTP ${res.status}: ${snippet(text)}`);
    }
    if (!res.ok) return fail('couldnt_check', 'http_error', `HTTP ${res.status}`);
    if (/Fraud Prevention|Zu viele Abfragen|captcha/i.test(text)) {
      return fail('couldnt_check', 'blocked', snippet(text));
    }

    let data;
    try { data = JSON.parse(text); } catch { return fail('couldnt_check', 'layout_changed', snippet(text)); }
    if (!data || !Array.isArray(data.results)) return fail('couldnt_check', 'layout_changed', snippet(text));

    const all = data.results;
    const hits = all.filter((r) => r && r.type === 'company' && typeof r.name === 'string');

    // Exact match after normalisation (legal form included). If the user typed no legal form,
    // also accept the same core name under any legal form.
    const want = fold(name);
    const wantCore = coreOf(name);
    const exact = hits.filter((r) => fold(r.name) === want);
    const core = hasLegalForm(name) || !wantCore ? [] : hits.filter((r) => coreOf(r.name) === wantCore);
    const matched = exact.length ? exact : core;

    if (matched.length) {
      const seen = new Set();
      const records = [];
      for (const r of matched) {
        const url = r.url || '';
        if (seen.has(url)) continue;
        seen.add(url);
        records.push({ name: r.name, city: r.description || '', register: registerFrom(url), url });
      }
      const excerpt = records.slice(0, 3)
        .map((r) => `${r.name} (${r.city}${r.register ? ', ' + r.register : ''})`)
        .join('; ');
      return { status: 'found', reason: '', records, source_url: sourceUrl, excerpt: excerpt.slice(0, 500) };
    }

    if (all.length >= CUT_OFF_SIZE) {
      return fail('couldnt_check', 'other', `${all.length} suggestions returned, none an exact match; the list may be cut off`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `0 exact matches among ${all.length} suggestions`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', String(err?.message || err).slice(0, 300));
  }
}
