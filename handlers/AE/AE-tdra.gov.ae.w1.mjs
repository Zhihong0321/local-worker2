export const meta = {
  task: 'AE-tdra.gov.ae',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'marketing_name', 'model_name', 'registration_no', 'expiry_date'],
  canary: {
    found: 'CERTOYD TELECOMMUNICATION EQUIPMENTS & ELECTRONICS TRADING L.L.C',
    not_found: 'شركة زيكس للتجارة ذ.م.م',
  },
};

const PAGE_URL = 'https://tdra.gov.ae/en/approved-equipments';
const API_URL = 'https://tdra.gov.ae/api/sitecore/TasDGT/GetApprovedEquipments';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const DEADLINE_MS = 45000;

// Legal-form words, dots removed. Used to build a shorter search string and to ignore them in the fallback search.
const LEGAL_WORDS = new Set(['llc', 'fze', 'fzc', 'fzllc', 'fz', 'ltd', 'limited', 'inc', 'co', 'sdn', 'bhd', 'dmcc', 'gmbh',
  'pjsc', 'psc', 'ذمم', 'شذمم', 'شمع', 'ش', 'ذ', 'م', 'ع']);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Canonical form for comparing company names: case, punctuation, spacing and legal-form spelling ignored. */
function squash(s) {
  return decodeEntities(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\./g, '')           // L.L.C -> LLC, ذ.م.م -> ذمم
    .replace(/&/g, ' and ')       // "&" and "AND" are the same
    .replace(/limited/g, 'ltd')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The name with legal-form words removed, punctuation kept (used for the fallback search). */
function coreName(keyword) {
  return keyword
    .replace(/\./g, '')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_WORDS.has(w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')))
    .join(' ')
    .trim();
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Open the register page: get its cookies and the anti-forgery token the search API requires. */
async function openSession() {
  const res = await fetch(PAGE_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: fail('couldnt_check', 'blocked', PAGE_URL, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('couldnt_check', 'http_error', PAGE_URL, `HTTP ${res.status}`) };
  const html = await res.text();
  const token = html.match(/name="__RequestVerificationToken"[^>]*?value="([^"]+)"/i)?.[1];
  if (!token || !html.includes('GetApprovedEquipments')) {
    return { fail: fail('couldnt_check', 'layout_changed', PAGE_URL, html.slice(0, 200)) };
  }
  const rawCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  const jar = new Map();
  for (const raw of rawCookies) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return { token, cookie };
}

/** One page of the search. Returns { total, rows } or { fail }. Pages are 1-based. */
async function fetchPage(session, query, page, timeoutMs) {
  const body = new URLSearchParams({
    SearchText: '',
    OrganizationNames: query,
    'pagingDTO[CurrentPageNumber]': String(page),
    'pagingDTO[PageCount]': String(PAGE_SIZE),
    'pagingDTO[IsFilterUpdated]': page === 1 ? 'true' : 'false',
    __RequestVerificationToken: session.token,
  });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': PAGE_URL,
      'Cookie': session.cookie,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 403 || res.status === 429) return { fail: fail('couldnt_check', 'blocked', API_URL, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('couldnt_check', 'http_error', API_URL, `HTTP ${res.status}`) };
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { return { fail: fail('couldnt_check', 'layout_changed', API_URL, text.slice(0, 200)) }; }
  if (!j || !j.PagingDTO || typeof j.PV !== 'string' || typeof j.PagingDTO.TotalCount !== 'number') {
    return { fail: fail('couldnt_check', 'layout_changed', API_URL, text.slice(0, 200)) };
  }
  const rows = [...j.PV.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cleanText(c[1]));
    if (cells.length < 5) return null;
    return { marketing_name: cells[0], model_name: cells[1], registration_no: cells[2], expiry_date: cells[3], org: cells[4] };
  }).filter(Boolean);
  return { total: j.PagingDTO.TotalCount, rows };
}

/** Read every page of one search string. partial=true when a limit stopped it before the end. */
async function searchAll(session, query, deadline) {
  const rows = [];
  let total = 0;
  let partial = false;
  for (let page = 1; ; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) { partial = true; break; }
    if (page > MAX_PAGES) { partial = true; break; }
    const r = await fetchPage(session, query, page, Math.min(25000, remaining));
    if (r.fail) {
      if (page === 1) return { fail: r.fail };
      partial = true;
      break;
    }
    total = r.total;
    rows.push(...r.rows);
    if (r.rows.length === 0 || rows.length >= total) break;
  }
  return { rows, total, partial };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword ?? '').trim();
  const target = squash(kw);
  if (!target) return fail('couldnt_check', 'other', PAGE_URL, 'empty company name');
  try {
    const session = await openSession();
    if (session.fail) return session.fail;

    const deadline = Date.now() + DEADLINE_MS;
    const queries = [kw];
    const core = coreName(kw);
    if (core && core !== kw) queries.push(core);

    for (const q of queries) {
      const r = await searchAll(session, q, deadline);
      if (r.fail) return r.fail;
      const matched = r.rows.filter((row) => squash(row.org) === target);
      if (matched.length > 0) {
        const partialNote = r.partial ? ` (partial: stopped at ${r.rows.length} of ${r.total} rows)` : '';
        return {
          status: 'found',
          reason: '',
          records: matched.map((row) => ({
            name: row.org,
            marketing_name: row.marketing_name,
            model_name: row.model_name,
            registration_no: row.registration_no,
            expiry_date: row.expiry_date,
          })),
          source_url: PAGE_URL,
          excerpt: `${matched.length} approved-equipment record(s) for "${matched[0].org}"${partialNote}`.slice(0, 300),
        };
      }
      if (r.partial) {
        return fail('couldnt_check', 'other', PAGE_URL, `search for "${q}" stopped before all ${r.total} rows were read`);
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `0 approved-equipment records for "${kw}" (searched: ${queries.join(' | ')})`.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail('couldnt_check', timedOut ? 'timeout' : 'other', PAGE_URL, String(err?.message || err));
  }
}
