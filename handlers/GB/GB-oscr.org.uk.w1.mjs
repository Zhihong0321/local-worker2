export const meta = {
  task: 'GB-oscr.org.uk',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'number', 'status', 'income', 'postcode', 'detail_url'],
  canary: { found: 'The British Red Cross Society', not_found: 'Kwrzqplv Holdings Limited' },
};

const BASE = 'https://www.oscr.org.uk';
const SEARCH_PAGE = `${BASE}/search`;
const SEARCH_POST = `${BASE}/CharitySearch/CharitySearch`;
// A name that is known to be listed. The register must answer it with results for a "no match" to count as a normal answer.
const CONTROL_KEYWORD = 'British Red Cross';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function browserHeaders() {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
  };
}

function normalize(str) {
  let s = (str || '').toLowerCase().replace(/&/g, ' and ');
  s = s.replace(/\bcharitable incorporated organi[sz]ation\b/g, ' ');
  let words = s.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  words = words.filter((w) => !['limited', 'ltd', 'plc', 'llp', 'lp', 'cio', 'scio'].includes(w));
  if (words[0] === 'the') words = words.slice(1);
  return words.join('');
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Result rows: <td>SC number</td><td class="charity-name"><a href=...>name</a></td><td>income</td><td>postcode</td> */
function parseRows(html) {
  const rows = [];
  const re = /<td[^>]*>\s*(SC\d+)\s*<\/td>\s*<td[^>]*class="charity-name"[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    rows.push({
      number: cleanText(m[1]),
      name: cleanText(m[3]),
      income: cleanText(m[4]),
      postcode: cleanText(m[5]),
      detail_url: new URL(decodeEntities(m[2]), BASE).href,
    });
  }
  return rows;
}

function reasonFor(r) {
  if (r.error) return r.error === 'timeout' ? 'timeout' : 'other';
  if (r.kind === 'other' && r.http === 200) return 'layout_changed';
  return 'http_error';
}

/** One search request. Never throws: the outcome is classified in `kind`. */
async function search(keyword, status, token, cookie) {
  const out = { status, kind: 'other', http: 0, rows: [], html: '', error: '' };
  try {
    const body = new URLSearchParams({ __RequestVerificationToken: token, Keyword: keyword, perPage: '500', CharityStatus: status });
    const res = await fetch(SEARCH_POST, {
      method: 'POST',
      headers: {
        ...browserHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': SEARCH_PAGE,
        'Origin': BASE,
        'Cookie': cookie,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    out.http = res.status;
    out.html = await res.text();
    const count = Number((out.html.match(/(\d+)\s+Results?\s+Returned/i) || [])[1]);
    if (res.status === 403 || res.status === 429) {
      out.kind = 'blocked';
    } else if (res.status === 500 && out.html.trim() === '') {
      // The register answers a query with no matching charity by an empty HTTP 500. Judged only together with the control.
      out.kind = 'zero';
    } else if (res.status === 200 && Number.isFinite(count)) {
      out.rows = parseRows(out.html).map((r) => ({ ...r, status: status === 'True' ? 'Active' : 'Former' }));
      if (count > 0 && out.rows.length === 0) out.kind = 'other';
      else out.kind = 'ok';
    }
  } catch (err) {
    out.error = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
  }
  return out;
}

const fail = (reason, excerpt, source_url) => ({
  status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500),
});

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  if (!name) return fail('other', 'empty name', SEARCH_PAGE);
  try {
    // Step 1: the search page gives the session cookie and the anti-forgery token the search needs.
    const page = await fetch(SEARCH_PAGE, { headers: browserHeaders(), signal: AbortSignal.timeout(25000) });
    if (page.status === 403 || page.status === 429) return fail('blocked', `HTTP ${page.status} on the search page`, SEARCH_PAGE);
    if (!page.ok) return fail('http_error', `HTTP ${page.status} on the search page`, SEARCH_PAGE);
    const pageHtml = await page.text();
    const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!tokenMatch || !pageHtml.includes('charitySearchForm')) {
      return fail('layout_changed', 'search form or token not found', SEARCH_PAGE);
    }
    const jar = new Map();
    for (const c of page.headers.getSetCookie()) {
      const pair = c.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const token = tokenMatch[1];

    // Step 2: the company name (active and former charities) and the control, in parallel.
    const [active, former, control] = await Promise.all([
      search(name, 'True', token, cookie),
      search(name, 'False', token, cookie),
      search(CONTROL_KEYWORD, 'True', token, cookie),
    ]);
    const all = [active, former, control];

    const blocked = all.find((r) => r.kind === 'blocked');
    if (blocked) return fail('blocked', `HTTP ${blocked.http} from the search (status ${blocked.status})`, SEARCH_POST);

    const matches = [...active.rows, ...former.rows].filter((r) => normalize(r.name) === normalize(name));
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({
          name: r.name, number: r.number, status: r.status, income: r.income, postcode: r.postcode, detail_url: r.detail_url,
        })),
        source_url: matches[0].detail_url,
        excerpt: matches.map((r) => `${r.number} ${r.name} (${r.status})`).join(' | ').slice(0, 500),
      };
    }

    // No exact match. A "not found" is only given when both name searches gave a normal answer and the control proves the register is answering.
    const bad = [active, former, control].find((r) => r.kind !== 'ok' && !(r.kind === 'zero' && r !== control));
    if (bad) return fail(reasonFor(bad), `search ${bad.status} gave HTTP ${bad.http} (${bad.kind}) ${bad.error}`.trim(), SEARCH_PAGE);

    const near = [...active.rows, ...former.rows].slice(0, 5).map((r) => `${r.number} ${r.name}`).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SEARCH_PAGE,
      excerpt: `No exact name match for "${name}" in the OSCR register (active or former). `
        + `Both name searches answered normally (empty HTTP 500 = no results, or a results list with no exact match); `
        + `the control search returned results. `
        + (near ? `Similar names, not the same name: ${near}` : 'No similar names returned.'),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err), SEARCH_PAGE);
  }
}
