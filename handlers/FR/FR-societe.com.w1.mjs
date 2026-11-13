export const meta = { task: 'FR-societe.com', want: 'w1', tier: 2, method: 'post', pdf: false, input: 'company name',
  fields: ['name', 'alt_name', 'siren', 'legal_form_code', 'activity_code', 'zipcode', 'city', 'location', 'status_code', 'url'],
  canary: { found: 'IDEAL CONNAISSANCES SAS', not_found: 'SOCIETE FANTOME ZQXW SARL' } };

// Societe.com search: the page is JavaScript-only, but its own JSON endpoint answers a plain form POST:
//   POST https://www.societe.com/cgi-bin/finder-api?serp   body: q=<name>&ftType=c
//   200 -> { data: { companies: [ { label, id (SIREN), url, ... } ] } }   (at most 120 per query)
//   404 with an empty JSON body -> the site's own "no result" answer (the page shows "Aucun résultat").
const API = 'https://www.societe.com/cgi-bin/finder-api?serp';
const SITE = 'https://www.societe.com';
const RESULT_CAP = 120;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['SAS', 'SASU', 'SARL', 'SARLU', 'EURL', 'SA', 'SCI', 'SNC', 'SCOP', 'SCA', 'SELARL', 'SELAS',
  'SELURL', 'SCP', 'SEL', 'SEM', 'SE', 'GIE', 'EI', 'EIRL', 'SCM', 'SC']);

/** Accents off, upper case, punctuation to spaces, words as a list. The site's search mangles accented letters. */
function words(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Drop a legal form at the start or the end of the name (SAS, SARL, SA ...), so "ACME SAS" and "ACME" compare equal. */
function core(list) {
  const t = list.slice();
  let changed = true;
  while (changed && t.length > 1) {
    changed = false;
    if (LEGAL_FORMS.has(t[t.length - 1])) { t.pop(); changed = true; }
    else if (LEGAL_FORMS.has(t[0])) { t.shift(); changed = true; }
  }
  return t;
}

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pageUrl = `https://www.societe.com/recherche?champs=${encodeURIComponent(String(keyword || '').trim())}`;
  try {
    const name = core(words(keyword));
    if (name.length === 0) return answer('couldnt_check', 'other', [], pageUrl, 'the name has no letters or digits');
    const query = name.join(' ');
    const key = name.join('');

    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ q: query, ftType: 'c' }).toString(),
      signal: AbortSignal.timeout(25000),
    });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();

    if (res.status === 403 || res.status === 429) {
      return answer('couldnt_check', 'blocked', [], pageUrl, `HTTP ${res.status}`);
    }
    if (res.status === 404) {
      if (ct.includes('application/json') && text.trim() === '') {
        return answer('not_found', '', [], pageUrl, `the site has no company for "${query}" (HTTP 404, empty result)`);
      }
      return answer('couldnt_check', 'http_error', [], pageUrl, `HTTP 404 ${ct}`);
    }
    if (!res.ok) {
      return answer('couldnt_check', 'http_error', [], pageUrl, `HTTP ${res.status}`);
    }
    if (!ct.includes('json')) {
      if (/captcha|datadome|cf-chl|access denied/i.test(text)) return answer('couldnt_check', 'blocked', [], pageUrl, 'bot check page');
      return answer('couldnt_check', 'layout_changed', [], pageUrl, text.slice(0, 300));
    }

    let json;
    try { json = JSON.parse(text); } catch { return answer('couldnt_check', 'layout_changed', [], pageUrl, 'not JSON'); }
    const companies = json && json.data && json.data.companies;
    if (!Array.isArray(companies)) return answer('couldnt_check', 'layout_changed', [], pageUrl, 'no data.companies list');

    const matches = companies.filter((c) => c && c.code === 'c' && core(words(c.label)).join('') === key);

    if (matches.length > 0) {
      const records = matches.map((c) => ({
        name: c.label,
        alt_name: c.alt || '',
        siren: c.id || '',
        legal_form_code: c.legal || '',
        activity_code: c.activity || '',
        zipcode: c.zipcode || '',
        city: c.city || '',
        location: String(c.location || '').trim(),
        status_code: c.status == null ? null : c.status,
        url: c.url ? new URL(c.url, SITE).href : '',
      }));
      return answer('found', '', records, pageUrl,
        `${matches.length} match(es) for "${query}" among ${companies.length} results: ${matches[0].label} (SIREN ${matches[0].id})`);
    }

    if (companies.length >= RESULT_CAP) {
      return answer('couldnt_check', 'other', [], pageUrl,
        `the site returned the maximum ${RESULT_CAP} results for "${query}" and none has this exact name; cannot confirm`);
    }
    return answer('not_found', '', [], pageUrl, `${companies.length} results for "${query}", none with this name`);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer('couldnt_check', timedOut ? 'timeout' : 'other', [], pageUrl, String((err && err.message) || err).slice(0, 300));
  }
}
