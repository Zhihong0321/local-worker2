export const meta = { task: 'AU-epa.vic.gov.au', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'licence_number', 'issued_date', 'status', 'suburb', 'attachments'],
  canary: { found: 'SELARAS KECHIL NOMINEES PTY LTD', not_found: 'ZZQXWORLD NOTREAL PTY LTD' } };

// EPA Victoria "Register of annual performance statements" (APS). Its search is a plain JSON GET that the public
// register page calls: /api/public-register/aps?companyName=...&page=N (10 rows a page, no login, no captcha).
const BASE = 'https://www.epa.vic.gov.au/api/public-register/aps';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
};
const MAX_PAGES = 5;          // at most 50 rows per search term
const BUDGET_MS = 40000;      // stop paging after 40 s so the whole call stays under 60 s
const LEGAL_FORMS = new Set(['PTY', 'LTD', 'LIMITED', 'PTE', 'INC', 'INCORPORATED', 'CO', 'CORP', 'CORPORATION',
  'COMPANY', 'LLC', 'NL', 'PROPRIETARY']);

/** Upper-case words without punctuation, legal form removed from the end: "Acme Pty. Ltd." -> "ACME". */
function normName(str) {
  const words = String(str || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ')
    .split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The name as typed, with the legal form dropped from the end (kept as typed otherwise). */
function stripLegalForm(str) {
  const words = String(str || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1].toUpperCase().replace(/[^A-Z]/g, ''))) words.pop();
  return words.join(' ');
}

function blocked(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Search one term through all pages (capped). Returns { ok, records, total, complete, url } or { fail }. */
async function searchTerm(term, startedAt) {
  const records = [];
  let total = 0;
  let firstUrl = '';
  let complete = true;
  for (let page = 1; ; page++) {
    const url = `${BASE}?companyName=${encodeURIComponent(term)}&page=${page}`;
    if (!firstUrl) firstUrl = url;
    let res;
    let text;
    try {
      res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      text = await res.text();
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { fail: blocked(timedOut ? 'timeout' : 'other', url, err && err.message ? err.message : err) };
    }
    if (res.status === 403 || res.status === 429) return { fail: blocked('blocked', url, `HTTP ${res.status}`) };
    if (!res.ok) return { fail: blocked('http_error', url, `HTTP ${res.status} ${text.slice(0, 200)}`) };
    if (/captcha|cf-chl|just a moment/i.test(text.slice(0, 2000))) return { fail: blocked('blocked', url, 'bot check page') };

    let body;
    try { body = JSON.parse(text); } catch { return { fail: blocked('layout_changed', url, text.slice(0, 200)) }; }
    if (body && body.error) return { fail: blocked('other', url, `site refused the search: ${body.message || body.statusMessage || 'error'}`) };
    if (!body || typeof body.total !== 'number' || !Array.isArray(body.records)) {
      return { fail: blocked('layout_changed', url, text.slice(0, 200)) };
    }
    total = body.total;
    records.push(...body.records);
    if (body.records.length === 0 || records.length >= total) break;
    if (page >= MAX_PAGES || Date.now() - startedAt > BUDGET_MS) { complete = false; break; }
  }
  return { ok: true, records, total, complete, url: firstUrl };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return blocked('other', BASE, 'empty company name');
    const target = normName(name);
    if (!target) return blocked('other', BASE, 'name has no letters or digits');

    // The site matches a substring of the company name. Try the name as typed first, then without the legal form.
    const terms = [...new Set([name, stripLegalForm(name)].filter(Boolean))];
    const startedAt = Date.now();
    const matches = [];
    const seen = new Map();
    let incomplete = false;
    let firstUrl = '';
    let sawTotal = 0;

    for (const term of terms) {
      const r = await searchTerm(term, startedAt);
      if (r.fail) return r.fail;
      if (!firstUrl) firstUrl = r.url;
      sawTotal = Math.max(sawTotal, r.total);
      if (!r.complete) incomplete = true;
      for (const row of r.records) {
        if (normName(row.companyname) !== target) continue;
        // The site returns one row per attachment: one licence/year can come as several rows. Merge them.
        const key = `${row.licenceno}|${row.issueddate}|${row.companyname}|${row.suburb}`;
        const attachments = (row.attachments || []).map((a) => ({ label: a.label || '', url: a.url || '' }));
        if (seen.has(key)) {
          const rec = seen.get(key);
          for (const a of attachments) if (!rec.attachments.some((x) => x.url === a.url)) rec.attachments.push(a);
          continue;
        }
        const rec = {
          name: row.companyname,
          licence_number: row.licenceno || '',
          issued_date: row.issueddate || '',
          status: row.status || '',
          suburb: row.suburb || '',
          attachments,
        };
        seen.set(key, rec);
        matches.push(rec);
      }
      if (matches.length > 0) break;
    }

    // Let the open keep-alive sockets settle before the caller exits the process (Node on Windows aborted with a
    // libuv assertion on exit otherwise).
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${matches.length} APS record(s) for ${first.name}; licence ${first.licence_number}, status ${first.status}, suburb ${first.suburb}`,
      };
    }
    if (incomplete) {
      return blocked('other', firstUrl, `the site lists ${sawTotal} rows for this search; checked the first ${MAX_PAGES * 10} and none matched the name exactly`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 exact matches for "${name}" on the APS register (site rows for the search: ${sawTotal})`,
    };
  } catch (err) {
    return blocked('other', BASE, err && err.message ? err.message : err);
  }
}
