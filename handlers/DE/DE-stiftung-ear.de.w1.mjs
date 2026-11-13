export const meta = {
  task: 'DE-stiftung-ear.de',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'weee_reg_nr', 'postcode', 'state', 'category', 'device_type', 'market_exit'],
  canary: { found: 'Bosch Automotive Service Solutions GmbH', not_found: 'Zzqxwv Nichtregistriert GmbH' },
};

// The register behind stiftung-ear.de's "Verzeichnisse" page: the ear-Portal directory of registered
// manufacturers / authorised representatives (ElektroG). It is a JSF form: GET for ViewState + session, then POST.
const PAGE = 'https://www.ear-system.de/ear-verzeichnis/hersteller.jsf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TOTAL_MS = 55000;   // the whole call must finish in under 60 s
const PER_FETCH_MS = 25000;

// Legal-form words, removed from the END of a name only (so "Acme GmbH & Co. KG" -> "acme").
const TRAILING = new Set(['gmbh', 'mbh', 'ag', 'kg', 'kgaa', 'ug', 'ohg', 'gbr', 'se', 'ev', 'eg', 'co', 'u', 'e', 'k',
  'haftungsbeschrankt']);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };

function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] ?? m;
  });
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: case, umlauts, punctuation and trailing legal form ignored. */
function norm(s) {
  const raw = String(s || '');
  let t = raw.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const toks = t ? t.split(' ') : [];
  while (toks.length > 1 && TRAILING.has(toks[toks.length - 1])) toks.pop();
  return toks.length ? toks.join(' ') : raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The name without its trailing legal form, as the user would search it. */
function searchBase(name) {
  const words = String(name || '').replace(/[.,&]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && TRAILING.has(norm(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

class Deadline extends Error {
  constructor() { super('the handler did not finish in time'); this.name = 'Deadline'; }
}

function fail(status, reason, excerpt) {
  return { status, reason, records: [], source_url: PAGE, excerpt: String(excerpt || '').slice(0, 300) };
}

async function fetchWithin(url, init, started) {
  const remaining = TOTAL_MS - (Date.now() - started);
  if (remaining <= 1000) throw new Deadline();
  return fetch(url, {
    ...init,
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(Math.min(PER_FETCH_MS, remaining)),
  });
}

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return list.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
}

function isBlockPage(html) {
  return /captcha|access denied|zugriff verweigert/i.test(html);
}

/** GET the search page: session cookie, ViewState token and the form's action URL. */
async function openSession(started) {
  const res = await fetchWithin(PAGE, {}, started);
  if (res.status === 403 || res.status === 429) return { fail: fail('couldnt_check', 'blocked', `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('couldnt_check', 'http_error', `HTTP ${res.status}`) };
  const html = await res.text();
  if (isBlockPage(html)) return { fail: fail('couldnt_check', 'blocked', 'bot or captcha page') };
  const vs = (html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/i) || [])[1];
  const action = (html.match(/<form[^>]*id="formId"[^>]*action="([^"]+)"/i) || [])[1];
  if (!vs || !action || !/name="formId:herstellername"/.test(html)) {
    return { fail: fail('couldnt_check', 'layout_changed', 'search form not found on the directory page') };
  }
  return { vs, action: new URL(decode(action), PAGE).href, cookie: cookiesFrom(res) };
}

/** Parse the result page: rows, whether the register says there are more rows than shown, or "no result". */
function parseResults(html) {
  if (isBlockPage(html)) return { blocked: true };
  if (/Keine Hersteller\/Bevollmächtigten[^<]{0,60}gefunden/i.test(html)) return { rows: [], truncated: false };
  const table = (html.match(/<table[\s\S]*?<\/table>/gi) || []).find((t) => /Hersteller-\/Bevollmächtigtenname/.test(t));
  if (!table) return { layout: true };
  const headers = (table.match(/<th[\s\S]*?<\/th>/gi) || []).map((th) => decode((th.match(/value="([^"]*)"/) || [])[1] || cleanText(th)));
  if (!/WEEE/i.test(headers[0] || '') || !/Hersteller/i.test(headers[1] || '')) return { layout: true };
  const body = table.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || '';
  const rows = [];
  for (const tr of body.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(cleanText);
    if (cells.length < 7) continue;
    rows.push({
      weee_reg_nr: cells[0], name: cells[1], postcode: cells[2], state: cells[3],
      category: cells[4], device_type: cells[5], market_exit: cells[6],
    });
  }
  if (!rows.length) return { layout: true };
  const total = parseInt((html.match(/Gesamtanzahl:\s*(\d+)/) || [])[1], 10);
  return { rows, truncated: Number.isFinite(total) && total > rows.length };
}

/** One search: a fresh session, then the POST with the exact text given. */
async function search(query, started) {
  const sess = await openSession(started);
  if (sess.fail) return { fail: sess.fail };
  const body = new URLSearchParams({
    'formId': 'formId',
    'formId:herstellername': query,
    'formId:postleitzahl': '',
    'formId:bundesland': '',
    'formId:registrierungsnummer': '',
    'formId:marke': '',
    'formId:kategorie': '',
    'formId:geraeteart': '',
    'formId:j_idt81': '',
    'formId:j_idt82': 'Hersteller/Bevollmächtigten anzeigen',
    'javax.faces.ViewState': sess.vs,
  });
  const res = await fetchWithin(sess.action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': sess.cookie },
    body: body.toString(),
  }, started);
  if (res.status === 403 || res.status === 429) return { fail: fail('couldnt_check', 'blocked', `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('couldnt_check', 'http_error', `HTTP ${res.status}`) };
  const parsed = parseResults(await res.text());
  if (parsed.blocked) return { fail: fail('couldnt_check', 'blocked', 'bot or captcha page') };
  if (parsed.layout) return { fail: fail('couldnt_check', 'layout_changed', 'result table not as expected') };
  return parsed;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword ?? '').trim().replace(/\s+/g, ' ');
    if (!kw) return fail('couldnt_check', 'other', 'empty company name');

    const target = norm(kw);
    // 1) the name as typed (the register matches exact text, case-insensitive);
    // 2) the name without its legal form, plus "*" (prefix match), to catch "GmbH" vs "GmbH & Co. KG" etc.
    const queries = [kw];
    const base = searchBase(kw);
    if (base.length >= 3) queries.push(`${base}*`);

    let truncated = false;
    const seen = [];
    for (const q of queries) {
      const r = await search(q, started);
      if (r.fail) return r.fail;
      if (r.truncated) truncated = true;
      const matches = r.rows.filter((row) => norm(row.name) === target);
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches,
          source_url: PAGE,
          excerpt: `Register lists "${matches[0].name}" (${matches.length} row(s), query "${q}")`,
        };
      }
      seen.push(...r.rows.map((row) => row.name));
    }

    if (truncated) {
      return fail('couldnt_check', 'other', 'register returned more rows than the first page; no exact match on it');
    }
    const near = [...new Set(seen)].slice(0, 5).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `Register answered; no entry matches "${kw}" (queries: ${queries.join(' | ')})${near ? `. Similar names: ${near}` : ''}`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'Deadline');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
