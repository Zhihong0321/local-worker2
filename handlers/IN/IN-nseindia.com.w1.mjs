export const meta = { task: 'IN-nseindia.com', want: 'w1', tier: 2, method: 'json_api', input: 'company name',
  fields: ['name', 'symbol', 'series', 'segment', 'url'],
  canary: { found: 'Infosys Limited', not_found: 'Dezeno Private Limited' } };

const SITE = 'https://www.nseindia.com';
const SEARCH = `${SITE}/api/NextApi/globalSearch/equity?symbol=`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Indian legal-form words. The site matches the start of the listed name, so these are dropped from the query.
// The compare step also drops a leading "The".
const LEGAL_FORMS = new Set(['limited', 'ltd', 'private', 'pvt', 'public', 'pub', 'company', 'co', 'corporation',
  'corp', 'incorporated', 'inc', 'llp', 'plc']);
const COMPARE_DROP = new Set([...LEGAL_FORMS, 'the']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function foldDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[‘’]/g, "'");
}

// Search text: the typed words with legal-form words removed. Punctuation stays, because the site matches
// the raw spelling ("Dr. Reddy's" finds the listing, "Dr Reddy's" does not).
function queryText(s) {
  return foldDiacritics(s).split(/\s+/).filter(w => w && !LEGAL_FORMS.has(w.toLowerCase().replace(/[^a-z]/g, ''))).join(' ');
}

// Compare key: lower-case words, "&" read as "and", punctuation and legal-form words removed.
function core(s) {
  return foldDiacritics(s).toLowerCase().replace(/&/g, ' and ').replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(w => w && !COMPARE_DROP.has(w)).join(' ');
}

const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });

async function searchOnce(query) {
  const url = SEARCH + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': `${SITE}/` },
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.text();
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', url, `HTTP ${res.status}`) };
  // The site answers HTTP 404 with an error body to non-Latin search text, so that is an http_error, never not_found.
  if (!res.ok) return { fail: fail('http_error', url, `HTTP ${res.status} ${body.slice(0, 120)}`) };
  let json;
  try { json = JSON.parse(body); } catch { return { fail: fail('layout_changed', url, body.slice(0, 200)) }; }
  if (!json || !Array.isArray(json.data)) return { fail: fail('layout_changed', url, body.slice(0, 200)) };
  return { url, rows: json.data };
}

function matchRows(rows, wanted) {
  const records = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.companyName !== 'string') continue;
    if (core(row.companyName) !== wanted) continue;
    const key = `${row.symbol}|${row.series}|${row.segment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      name: row.companyName,
      symbol: row.symbol || '',
      series: row.series || '',
      segment: row.segment || '',
      url: row.webUrl ? SITE + row.webUrl : (row.url ? SITE + row.url : ''),
    });
  }
  return records;
}

async function run(keyword) {
  const typed = foldDiacritics(keyword).trim();
  if (/[^\x00-\x7F]/.test(typed)) return fail('other', SEARCH, 'name has non-Latin letters; the NSE search only takes Latin text');

  const query = queryText(typed);
  const wanted = core(typed);
  if (!query || !wanted) return fail('other', SEARCH, 'no name words left after removing legal-form words and punctuation');

  // Try the name as typed. Then, only if nothing matched: the name with "&" for "and" (the site lists M&M as
  // "Mahindra & Mahindra"), and the longest word alone (the site matches the raw spelling, so a missing dot
  // in "Dr Reddy's" would otherwise hide "Dr. Reddy's Laboratories Limited"). Stays under the 60 s limit.
  const variants = [query];
  if (/\band\b/i.test(query)) variants.push(query.replace(/\band\b/gi, '&'));
  const words = query.split(' ');
  if (words.length > 1) variants.push(words.reduce((a, b) => (b.length > a.length ? b : a)));
  const uniq = [...new Set(variants)];

  const t0 = Date.now();
  let last = null;
  for (const q of uniq) {
    if (last && Date.now() - t0 > 30000) return fail('timeout', last.url, 'ran out of time before every search variant was tried');
    const s = await searchOnce(q);
    if (s.fail) return s.fail;
    last = s;
    const records = matchRows(s.rows, wanted);
    if (records.length) {
      return { status: 'found', reason: '', records, source_url: s.url,
        excerpt: records.map(r => `${r.name} (${r.symbol}, ${r.series}, ${r.segment})`).join('; ').slice(0, 300) };
    }
  }
  return { status: 'not_found', reason: '', records: [], source_url: last.url,
    excerpt: `no listing named "${typed}" in the results for: ${uniq.map(q => `"${q}"`).join(', ')}`.slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await run(keyword);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    answer = fail(timeout ? 'timeout' : 'other', SEARCH, String(err?.message || err));
  }
  // Node on Windows aborts when the process exits right after a fetch whose socket is still closing
  // (the runner calls process.exit at once). A short pause lets the socket close first. Verified: exit 0 with it, 127 without.
  await sleep(500);
  return answer;
}
