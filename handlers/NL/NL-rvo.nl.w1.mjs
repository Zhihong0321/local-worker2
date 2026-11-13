export const meta = { task: 'NL-rvo.nl', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'identifier', 'title', 'right_type', 'application_number', 'publication_number', 'publication_date', 'index_date', 'lapse_date', 'status', 'ipc_class'],
  canary: { found: 'Hoogovens Staal B.V.', not_found: 'Stichting Verzonnen Octrooi Bedrijf B.V.' } };

// Nederlands octrooiregister (RVO / Octrooicentrum Nederland), linked from https://www.octrooicentrum.nl/octrooien/zoeken-octrooidatabanken-en-octrooiregisters
// Flow: GET the search page (sets JSESSIONID and a CSRF token), then POST the applicant search as JSON, page by page.
const BASE = 'https://mijnoctrooi.rvo.nl/fo-eregister-view';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_ROWS = 100;
const MAX_PAGES = 10;          // at most 1000 hits read per company name
const START_NEW_PAGE_BEFORE_MS = 30000; // keeps the whole call under 60 s (each fetch can take up to 25 s)
const LEGAL_FORMS = new Set(['bv', 'nv', 'b', 'v', 'n', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'gmbh', 'ag', 'sa', 'plc',
  'corp', 'corporation', 'co', 'company', 'bvba', 'cv', 'vof', 'kg']);

function decodeEntities(s) {
  return String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Normalised company core: case, accents, punctuation, legal form and the Dutch "te <place>" seat suffix removed. */
function normalise(name) {
  let s = decodeEntities(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const seat = s.search(/(^|[\s,])te\s/);
  if (seat > 0) s = s.slice(0, seat);
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((t) => t && !LEGAL_FORMS.has(t)).join(' ');
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  return list.flatMap((c) => c.split(/,(?=\s*[^;,=\s]+=)/)).map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('=')).join('; ');
}

const fail = (status, reason, source_url, excerpt) => ({ status, reason, records: [], source_url, excerpt: String(excerpt ?? '').slice(0, 300) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const sourceUrl = `${BASE}/search`;
  try {
    const name = String(keyword ?? '').trim();
    const core = normalise(name);
    if (!core) return fail('couldnt_check', 'other', sourceUrl, 'no company name left after removing legal form');

    // 1. Session page: sets JSESSIONID and gives the CSRF token.
    const home = await fetch(`${BASE}/search`, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (home.status === 403 || home.status === 429) return fail('couldnt_check', 'blocked', sourceUrl, `HTTP ${home.status}`);
    if (!home.ok) return fail('couldnt_check', 'http_error', sourceUrl, `HTTP ${home.status}`);
    const homeText = await home.text();
    if (/recaptcha/i.test(home.url)) return fail('couldnt_check', 'blocked', sourceUrl, `redirected to ${home.url}`);
    const csrf = homeText.match(/<meta name="_csrf" content="([^"]+)"/)?.[1];
    if (!csrf) return fail('couldnt_check', 'layout_changed', sourceUrl, homeText.slice(0, 200));
    const cookie = cookieHeader(home);

    // 2. Applicant search, page by page, keeping the holders whose normalised name equals the keyword's.
    const matches = [];
    const seenIds = new Set();
    const holders = new Map();
    let total = null;
    let scanned = 0;
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > START_NEW_PAGE_BEFORE_MS) break;
      const res = await fetch(`${BASE}/search`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-TOKEN': csrf,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE}/search`,
          'Cookie': cookie,
        },
        body: new URLSearchParams({ _csrf: csrf, applicant: core, indexName: 'patent', advancedSearch: '0',
          page: String(page), rows: String(PAGE_ROWS) }),
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', sourceUrl, `HTTP ${res.status}`);
      if (!res.ok) return fail('couldnt_check', 'http_error', sourceUrl, `HTTP ${res.status}`);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!json || !json.patents || !Array.isArray(json.patents.content)) {
        if (/recaptcha|captcha/i.test(res.url) || /captcha/i.test(text)) return fail('couldnt_check', 'blocked', sourceUrl, 'captcha or bot check');
        return fail('couldnt_check', 'layout_changed', sourceUrl, text.slice(0, 200));
      }
      const t = Number(json.patents.totalElements ?? json.total);
      if (!Number.isFinite(t)) return fail('couldnt_check', 'layout_changed', sourceUrl, 'no total in search result');
      total = t;
      const rows = json.patents.content;
      for (const r of rows) {
        const holder = decodeEntities(r.applicantHolder);
        if (normalise(holder) === core) {
          const id = `${r.id}|${r.applicationIdentifier}|${r.publicationNumber}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            matches.push({ name: holder, identifier: r.applicationIdentifier ?? null, title: decodeEntities(r.title) || null,
              right_type: r.rightType ?? null, application_number: r.applicationNumber ?? null,
              publication_number: r.publicationNumber ?? null, publication_date: r.publicationDate ?? null,
              index_date: r.indexDate ?? null, lapse_date: r.lapseDate ?? null, status: r.status ?? null, ipc_class: r.ipcClass ?? null });
          }
        } else {
          holders.set(holder, (holders.get(holder) || 0) + 1);
        }
      }
      scanned += rows.length;
      if (rows.length === 0 || rows.length < PAGE_ROWS || scanned >= total) { complete = true; break; }
    }
    if (!complete && scanned < total && matches.length === 0 && total > 0) {
      return fail('couldnt_check', 'other', sourceUrl, `search "${core}" has ${total} hits; read ${scanned} before the limit, no exact name match`);
    }

    if (matches.length > 0) {
      const note = complete ? '' : `; only the first ${scanned} of ${total} hits were read`;
      return { status: 'found', reason: '', records: matches, source_url: sourceUrl,
        excerpt: `${matches.length} patent entries for "${name}" in ${total} search hits${note}` };
    }
    const near = [...holders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h).join('; ');
    return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
      excerpt: total === 0 ? `0 results for "${core}"` : `${total} hits for "${core}", none with the name "${name}"${near ? `; nearest holders: ${near}` : ''}` };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', sourceUrl, String(e).slice(0, 200));
  }
}
