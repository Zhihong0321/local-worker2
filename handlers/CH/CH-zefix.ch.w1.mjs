export const meta = {
  task: 'CH-zefix.ch',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'uid', 'uid_formatted', 'chid', 'legal_form_id', 'legal_seat', 'status', 'status_date', 'delete_date', 'cantonal_excerpt_url'],
  canary: { found: 'Swisscom (Schweiz) AG', not_found: 'Zzqxv Blumenfreund Testgesellschaft GmbH' },
};

const SEARCH_URL = 'https://www.zefix.ch/ZefixREST/api/v1/firm/search.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;            // larger page sizes are slow or hang on the Zefix side; paging offset is not honoured
const NO_RESULT_CODE = 'API.ZFR.SEARCH.NORESULT';
const NEW_SEARCH_BEFORE_MS = 25000; // a second search only starts if the first finished early: total stays under 60 s

// Legal forms as token sequences (after normalisation) -> short key. Only a trailing form is taken off a name.
const FORMS = [
  [['aktiengesellschaft'], 'ag'], [['ag'], 'ag'],
  [['societe', 'anonyme'], 'sa'], [['societa', 'anonima'], 'sa'], [['s', 'a'], 'sa'], [['sa'], 'sa'],
  [['gesellschaft', 'mit', 'beschrankter', 'haftung'], 'gmbh'], [['gmbh'], 'gmbh'],
  [['s', 'a', 'r', 'l'], 'sarl'], [['sarl'], 'sarl'],
  [['s', 'a', 'g', 'l'], 'sagl'], [['sagl'], 'sagl'],
  [['s', 'r', 'l'], 'srl'], [['srl'], 'srl'],
  [['ltd'], 'ltd'], [['llc'], 'llc'], [['inc'], 'inc'],
  [['kgaa'], 'kgaa'], [['kg'], 'kg'], [['se'], 'se'],
  [['genossenschaft'], 'genossenschaft'], [['stiftung'], 'stiftung'], [['verein'], 'verein'],
].sort((a, b) => b[0].length - a[0].length);

// "in liquidation" style markers are not part of the legal name for matching purposes.
const LIQUIDATION_MARKERS = [['in', 'liquidation'], ['en', 'liquidation']];

function removeSequence(tokens, seq) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (seq.every((t, k) => tokens[i + k] === t)) { i += seq.length - 1; continue; }
    out.push(tokens[i]);
  }
  return out;
}

/** Split a company name into { core, form }. translit = true also writes umlauts as ae/oe/ue (used for matching). */
function parseName(input, translit = true) {
  let s = String(input || '').toLowerCase();
  if (translit) s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  s = s.replace(/&/g, ' und ').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  let tokens = s ? s.split(' ') : [];
  for (const m of LIQUIDATION_MARKERS) tokens = removeSequence(tokens, m);
  if (tokens.length >= 2 && tokens[tokens.length - 2] === 'i' && tokens[tokens.length - 1] === 'l') tokens = tokens.slice(0, -2);
  let form = '';
  for (const [seq, key] of FORMS) {
    if (tokens.length > seq.length && seq.every((t, k) => tokens[tokens.length - seq.length + k] === t)) {
      form = key;
      tokens = tokens.slice(0, tokens.length - seq.length);
      break;
    }
  }
  return { core: tokens.join(' '), form };
}

/** Same company = same normalised core name, and the same legal form when the typed name gives one. */
function sameCompany(typed, listed) {
  if (!typed.core || typed.core !== listed.core) return false;
  if (typed.form && listed.form !== typed.form) return false;
  return true;
}

function toRecord(item) {
  return {
    name: item.name ?? '',
    uid: item.uid ?? '',
    uid_formatted: item.uidFormatted ?? '',
    chid: item.chidFormatted ?? item.chid ?? '',
    legal_form_id: item.legalFormId ?? null,
    legal_seat: item.legalSeat ?? '',
    status: item.status ?? '',
    status_date: item.shabDate ?? '',
    delete_date: item.deleteDate ?? null,
    cantonal_excerpt_url: item.cantonalExcerptWeb ?? '',
  };
}

function couldnt(reason, excerpt, source_url = SEARCH_URL) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** One search request. Returns { kind: 'ok' | 'noresult' | 'fail', ... }. Never throws. */
async function search(term) {
  let res, text;
  try {
    res = await fetch(SEARCH_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: term, languageKey: 'de', maxEntries: PAGE, offset: 0, activeOnly: false }),
    });
    text = await res.text();
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { kind: 'fail', reason: timedOut ? 'timeout' : 'other', excerpt: `${err && err.name}: ${String(err && err.message).slice(0, 200)}` };
  }

  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }

  if (res.status === 403 || res.status === 401 || res.status === 429) {
    return { kind: 'fail', reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (res.status === 404 && body && body.error && body.error.code === NO_RESULT_CODE) {
    return { kind: 'noresult' };
  }
  if (!res.ok) {
    return { kind: 'fail', reason: 'http_error', excerpt: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  if (body && body.error && body.error.code === NO_RESULT_CODE) {
    return { kind: 'noresult' };
  }
  if (!body || !Array.isArray(body.list)) {
    if (/captcha|recaptcha|access denied/i.test(text)) return { kind: 'fail', reason: 'blocked', excerpt: text.slice(0, 200) };
    return { kind: 'fail', reason: 'layout_changed', excerpt: text.slice(0, 200) };
  }
  return { kind: 'ok', list: body.list, more: body.hasMoreResults === true };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows can abort (exit 127, UV_HANDLE_CLOSING) when the process exits while a fetch socket is still
  // closing. A short pause lets the sockets close before the caller exits the process.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  try {
    const typed = String(keyword ?? '').replace(/\s+/g, ' ').trim();
    if (!typed) return couldnt('other', 'empty company name');

    const want = parseName(typed);
    if (!want.core) return couldnt('other', `no company name left after removing the legal form in "${typed}"`);

    // Search 1: the name as typed. Search 2: the name without legal form, accents folded, punctuation removed.
    // The site returns no result for some punctuated forms ("Nestle S.A.") but finds the core name.
    const terms = [typed];
    const core = parseName(typed, false);
    const coreTerm = core.core;
    if (coreTerm && coreTerm.toLowerCase() !== typed.toLowerCase()) terms.push(coreTerm);

    const matches = new Map();
    let lastFail = null;
    let sawNoResult = false;
    let sawNames = [];
    let truncated = false;

    for (const term of terms) {
      if (Date.now() - started >= NEW_SEARCH_BEFORE_MS) {
        lastFail = { reason: 'timeout', excerpt: 'time budget used up before every search variant ran' };
        break;
      }
      const r = await search(term);
      if (r.kind === 'fail') { lastFail = r; continue; }
      if (r.kind === 'noresult') { sawNoResult = true; continue; }

      for (const item of r.list) {
        if (!item || !item.uid || !item.name) continue;
        if (sameCompany(want, parseName(item.name))) matches.set(item.uid, toRecord(item));
      }
      if (matches.size > 0) break;
      if (r.more) truncated = true;
      sawNames = sawNames.concat(r.list.map((x) => x.name)).slice(0, 8);
    }

    if (matches.size > 0) {
      const records = [...matches.values()];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: SEARCH_URL,
        excerpt: records.slice(0, 3).map((r) => `${r.name} | ${r.uid_formatted} | ${r.status}`).join(' ; ').slice(0, 500),
      };
    }

    if (lastFail) {
      return couldnt(lastFail.reason, lastFail.excerpt);
    }
    if (truncated) {
      return couldnt('other', `the search returned more results than one page; the exact name was not on the first page for "${typed}"`);
    }
    if (sawNoResult && sawNames.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `The site returned no results for "${typed}".`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SEARCH_URL,
      excerpt: `No exact match for "${typed}". Names returned: ${sawNames.join(' ; ')}`.slice(0, 500),
    };
  } catch (err) {
    return couldnt('other', `handler error: ${String((err && err.message) || err).slice(0, 300)}`);
  }
}
