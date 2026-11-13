export const meta = {
  task: 'IN-nclat.gov.in',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'case_no', 'filing_no', 'parties', 'case_date', 'status', 'bench'],
  canary: { found: 'KKP Spinning Mills Private Ltd', not_found: 'भारत लोकल ट्रेडिंग कंपनी प्राइवेट लिमिटेड' },
};

// NCLAT case status, "Search by party name". Step 1 GET the page (session cookie + form token),
// step 2 POST the same form the page's own JavaScript posts to cases_details, for both benches and both party sides.
const BASE = 'https://nclat.nic.in';
const PAGE = `${BASE}/display-board/cases`;
const SEARCH = `${BASE}/display-board/cases_details`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BENCHES = [['delhi', 'New Delhi'], ['chennai', 'Chennai']];
const PARTY_SIDES = [1, 2]; // select_party: 1 = Main Party, 2 = Additional Party
const EXACT = '2';          // exact_search_word: 2 = Exact Search
const LEGAL_FORM = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP']);

/** Normalised name: upper case, no punctuation, no legal form, no leading "The", no "M/s", no "(P)"-style notes. */
function decode(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/gi, '&');
}

function normalise(name) {
  let s = decode(name).toUpperCase();
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/&/g, ' AND ');
  s = s.replace(/\bM\s*\/\s*S\b\.?/g, ' ');
  s = s.replace(/[^\p{L}\p{N} ]+/gu, ' ');
  let toks = s.split(/\s+/).filter(Boolean);
  if (toks[0] === 'THE') toks = toks.slice(1);
  return toks.filter((t) => !LEGAL_FORM.has(t)).join(' ');
}

/**
 * What to type in the party box: the name's words without notes in brackets, "M/s" or the legal form.
 * The site's search cannot match a word with "&" in it, so the longest run of words between such words is used.
 * Null when nothing searchable is left.
 */
function searchTerm(kw) {
  let s = decode(kw).replace(/\([^)]*\)/g, ' ').replace(/\bM\s*\/\s*S\b\.?/gi, ' ');
  const toks = s.split(/\s+/).map((t) => t.replace(/[.,]+$/, '')).filter(Boolean)
    .filter((t) => !LEGAL_FORM.has(t.toUpperCase()));
  const runs = [];
  let cur = [];
  for (const t of toks) {
    if (t.includes('&')) { if (cur.length) runs.push(cur); cur = []; } else cur.push(t);
  }
  if (cur.length) runs.push(cur);
  runs.sort((a, b) => b.join(' ').length - a.join(' ').length);
  return runs.length ? runs[0].join(' ').slice(0, 50) : null;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function cookieHeader(headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function errReason(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

const BOT_WALL = /captcha|access denied|are you a robot|verify you are human/i;

/** One party-name search. Never throws. */
async function runSearch(cookie, token, loc, side, partyName) {
  const body = new URLSearchParams({
    _token: token, search_by: 'party_wise', location: loc, case_type: '', case_number: '',
    case_year: 'All', diary_no: '', advocate_name: '', text_name: '', filling_no: '',
    exact_search_word: EXACT, party_name: partyName, select_party: String(side),
    case_status: 'all', from_date: '', to_date: '',
  });
  let res;
  try {
    res = await fetch(SEARCH, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE,
        'Origin': BASE,
        'Cookie': cookie,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return { ok: false, reason: errReason(e), excerpt: String(e?.message || e).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };

  let text;
  try { text = await res.text(); } catch (e) { return { ok: false, reason: errReason(e), excerpt: String(e?.message || e).slice(0, 200) }; }
  let json;
  try { json = JSON.parse(text); } catch {
    return { ok: false, reason: BOT_WALL.test(text) ? 'blocked' : 'layout_changed', excerpt: text.slice(0, 200) };
  }
  if (!json || !Array.isArray(json.data) || json.data.some((r) => !Array.isArray(r) || r.length < 6)) {
    return { ok: false, reason: 'layout_changed', excerpt: JSON.stringify(json).slice(0, 200) };
  }
  return { ok: true, rows: json.data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  try {
    const kwCore = normalise(kw);
    if (!kwCore) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }
    const partyName = searchTerm(kw);
    if (!partyName) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'the name has no word the site search can match' };
    }

    // Step 1: the search page gives the session cookie and the form token.
    let page;
    try {
      page = await fetch(PAGE, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      return { status: 'couldnt_check', reason: errReason(e), records: [], source_url: PAGE, excerpt: String(e?.message || e).slice(0, 200) };
    }
    if (page.status === 403 || page.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${page.status}` };
    }
    if (!page.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${page.status}` };
    }
    const html = await page.text();
    const tokenMatch = html.match(/name="_token" value="([^"]+)"/);
    if (!tokenMatch || !html.includes('cases_details')) {
      return {
        status: 'couldnt_check',
        reason: BOT_WALL.test(html) ? 'blocked' : 'layout_changed',
        records: [], source_url: PAGE, excerpt: html.slice(0, 200),
      };
    }
    const cookie = cookieHeader(page.headers);

    // Step 2: both benches, both party sides, in parallel.
    const jobs = [];
    for (const [loc, label] of BENCHES) {
      for (const side of PARTY_SIDES) {
        jobs.push(runSearch(cookie, tokenMatch[1], loc, side, partyName).then((r) => ({ ...r, label })));
      }
    }
    const results = await Promise.all(jobs);

    // Match the company, not just similar words: normalised name must equal one side of "A VS B".
    const records = [];
    const seen = new Set();
    let rowsSeen = 0;
    for (const r of results.filter((x) => x.ok)) {
      for (const row of r.rows) {
        rowsSeen++;
        const [, filingNo, caseNo, parties, caseDate, status] = row;
        const hit = String(parties).split(/\s+vs\.?\s+/i)
          .map((s) => s.trim())
          .find((s) => normalise(s) === kwCore);
        if (!hit) continue;
        const key = `${filingNo}|${caseNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          name: stripTags(decode(hit)),
          case_no: stripTags(caseNo),
          filing_no: stripTags(filingNo),
          parties: stripTags(decode(parties)),
          case_date: stripTags(caseDate),
          status: stripTags(status),
          bench: r.label,
        });
      }
    }

    if (records.length) {
      const first = records[0];
      return {
        status: 'found', reason: '', records, source_url: PAGE,
        excerpt: `${first.case_no} | ${first.parties} | ${first.status}`.slice(0, 500),
      };
    }

    const failed = results.filter((x) => !x.ok);
    if (failed.length) {
      const reason = failed.find((x) => x.reason === 'blocked')?.reason || failed[0].reason;
      const detail = failed.map((x) => `${x.label} side ${x.excerpt}`).join('; ');
      return { status: 'couldnt_check', reason, records: [], source_url: PAGE, excerpt: detail.slice(0, 500) };
    }
    // The site's party search does not reliably return names with "&" (IL&FS was not found by any spelling tried),
    // so an empty answer for such a name cannot prove the company is not listed.
    if (kw.includes('&')) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE,
        excerpt: `No match for "${kw}" among ${rowsSeen} rows; the site's party search is not reliable for names with "&".`,
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: PAGE,
      excerpt: `Searched New Delhi and Chennai benches by party name "${partyName}" (main and additional party): ${rowsSeen} case rows, none with a party named "${kw}".`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
