export const meta = {
  task: 'TW-dnb.com.tw',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'duns', 'city', 'country'],
  canary: { found: '協記精密工業股份有限公司', not_found: '不存在測試股份有限公司' },
};

const ENDPOINT = 'https://www.dunsregistered.com/AJAX_Provider.svc/GetSearchResults';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TAIWAN_CODE = '10206';

// Legal-form words, already squashed (no spaces/punctuation, lower case). Removed only from the END of a name.
const LEGAL_SUFFIXES = ['股份有限公司', '有限公司', '有限責任公司', 'sdnbhd', 'pteltd', 'coltd', 'limited', 'ltd',
  'incorporated', 'inc', 'corporation', 'corp', 'company', 'co', 'llc', 'plc', 'gmbh'];

/** Lower case, full-width to half-width, 臺 and 台 treated alike, punctuation and spaces removed. */
function squash(str) {
  return String(str || '').normalize('NFKC').toLowerCase().replace(/臺/g, '台')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Squashed name with the legal form removed, so "X CO., LTD." and "X" compare equal. */
function core(str) {
  let s = squash(str);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s.length > suffix.length && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return s;
}

function isTaiwan(country) {
  const c = squash(country);
  return c === '台灣' || c === 'taiwan';
}

/** One search request. Returns { ok, rows, status, text } or a failure marker. */
async function search(name, deadline) {
  const url = new URL(ENDPOINT);
  const comp = { __type: 'CompanyShort:#AJAXobjects', OTN: 0, DUNS: '', CompanyName: name, City: '', Country: '', ListingCode: '' };
  url.searchParams.set('Company', JSON.stringify(comp));
  url.searchParams.set('language', '4');
  const timeoutMs = Math.max(1000, Math.min(25000, deadline - Date.now()));
  const res = await fetch(url.href, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 403 || res.status === 429) {
    return { fail: 'blocked', status: res.status, url: url.href };
  }
  if (!res.ok) {
    return { fail: 'http_error', status: res.status, url: url.href };
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { fail: /captcha|verify|access denied/i.test(text) ? 'blocked' : 'layout_changed', status: res.status, url: url.href, text: text.slice(0, 300) };
  }
  if (!json || !Array.isArray(json.d)) {
    return { fail: 'layout_changed', status: res.status, url: url.href, text: text.slice(0, 300) };
  }
  return { ok: true, rows: json.d, url: url.href };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const deadline = started + 50000;
  try {
    const typed = String(keyword || '').trim();
    if (!typed) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT, excerpt: 'empty keyword' };
    }
    const target = core(typed);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT, excerpt: 'keyword has no name left after removing the legal form' };
    }

    // Query 1: the name as typed. Query 2 (only if needed): the name without its legal form, which avoids
    // punctuation differences such as "CO LTD" vs "CO., LTD.".
    const queries = [typed];
    const bare = core(typed);
    if (bare && squash(typed) !== bare) queries.push(bare);

    let lastUrl = ENDPOINT;
    let seenOtherCountry = [];
    let answered = false;

    for (const q of queries) {
      if (answered && Date.now() > started + 30000) break;
      const r = await search(q, deadline);
      if (r.fail) {
        return { status: 'couldnt_check', reason: r.fail, records: [], source_url: r.url,
          excerpt: `HTTP ${r.status ?? ''} ${r.text ?? ''}`.trim() };
      }
      answered = true;
      lastUrl = r.url;

      const matches = [];
      for (const row of r.rows) {
        if (core(row.CompanyName) !== target) continue;
        if (isTaiwan(row.Country)) {
          matches.push({
            name: row.CompanyName,
            duns: String(row.DUNS || ''),
            city: row.City || '',
            country: row.Country || '',
          });
        } else {
          seenOtherCountry.push(`${row.CompanyName} (${row.Country})`);
        }
      }
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches,
          source_url: r.url,
          excerpt: `${matches.length} Taiwan record(s) for "${typed}": ` +
            matches.map((m) => `${m.name} / DUNS ${m.duns} / ${m.city}`).join('; ').slice(0, 450),
        };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: seenOtherCountry.length
        ? `No Taiwan record for "${typed}". Same name only outside Taiwan: ${seenOtherCountry.slice(0, 5).join('; ')}`
        : `No record for "${typed}" in the D-U-N-S Registered directory`,
    };
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: aborted ? 'timeout' : 'other',
      records: [],
      source_url: ENDPOINT,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
