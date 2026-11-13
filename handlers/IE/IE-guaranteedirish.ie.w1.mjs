export const meta = { task: 'IE-guaranteedirish.ie', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'pk'],
  canary: { found: 'HYGEIA CHEMICALS LTD', not_found: 'Comhlacht Neamhliostaithe Teoranta' } };

// The Guaranteed Irish directory (directory.guaranteedirish.ie) loads its vendor list from this public JSON endpoint.
// It returns the whole list in one array of { pk, name }; query parameters are ignored, so the list is matched here.
const LIST_URL = 'https://directory.guaranteedirish.ie/api/v1/vendors/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal forms, English and Irish, dropped from the end of a name before comparing.
const LEGAL_FORMS = new Set(['ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'unlimited', 'ul', 'uc', 'llc', 'inc', 'gmbh', 'co', 'company', 'cuideachta']);

function normalize(str) {
  const words = String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await lookupOnce(keyword);
  await new Promise(r => setTimeout(r, 500)); // let the fetch sockets close before the runner exits
  return out;
}

async function lookupOnce(keyword) {
  try {
    const kwNorm = normalize(keyword);
    if (!kwNorm) return fail('other', LIST_URL, 'the company name has no letters or digits to match');

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return fail('blocked', LIST_URL, `HTTP ${res.status}`);
    }
    if (!res.ok) return fail('http_error', LIST_URL, `HTTP ${res.status}`);

    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      if (/captcha|challenge|access denied|cloudflare|log ?in/i.test(text)) return fail('blocked', LIST_URL, text.slice(0, 200));
      return fail('layout_changed', LIST_URL, text.slice(0, 200));
    }

    let list;
    try { list = JSON.parse(text); } catch { return fail('layout_changed', LIST_URL, text.slice(0, 200)); }
    if (!Array.isArray(list) || list.length === 0 || !list.every(v => v && typeof v.name === 'string')) {
      return fail('layout_changed', LIST_URL, JSON.stringify(list).slice(0, 200));
    }

    const matches = list.filter(v => normalize(v.name) !== '' && normalize(v.name) === kwNorm);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No vendor named "${keyword}" among the ${list.length} vendors in the Guaranteed Irish directory`,
      };
    }

    const records = matches.map(v => ({ name: v.name, pk: v.pk }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `Listed in the Guaranteed Irish directory as "${matches[0].name}" (pk ${matches[0].pk})`,
    };
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', LIST_URL, 'the vendor list did not answer in 25 s');
    return fail('other', LIST_URL, String((err && err.message) || err));
  }
}
