export const meta = {
  task: 'ID-tkdn.kemenperin.go.id',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['company_name', 'kind', 'cert_no', 'factory_address', 'province', 'product_name', 'merk', 'tipe', 'kbli', 'kd_hs', 'tkdn_value', 'bmp_value', 'lvi_name', 'issue_date', 'tgl_expire', 'cert_status'],
  canary: { found: 'PT Steel Pipe Industry Of Indonesia Tbk', not_found: 'PT Zzqxv Tidak Ada Sejahtera' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://tkdn.kemenperin.go.id/sertifikat';
const PAGE_SIZE = 10;
const MAX_PAGES = 5;
const START_NEW_PAGE_BEFORE_MS = 30000; // a page started later than this could run past the 60 s limit
const LEGAL_FORMS = new Set(['pt', 'cv', 'tbk', 'persero', 'perseroan', 'terbatas', 'ud', 'koperasi', 'firma']);

/** Name key: lower case, punctuation and spacing removed, legal form words dropped (PT, CV, Tbk, ...). */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/&/g, ' dan ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join('');
}

function decodeEntities(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** The page carries its data as JS string literals: __RESOLVED_RESOURCES[n] = "<JSON text>". Returns the parsed values. */
function decodeResources(html) {
  const out = [];
  const re = /__RESOLVED_RESOURCES\[\d+\] = "/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const open = re.lastIndex - 1;
    let j = re.lastIndex;
    while (j < html.length && html[j] !== '"') j += html[j] === '\\' ? 2 : 1;
    re.lastIndex = j + 1;
    try {
      out.push(JSON.parse(JSON.parse(html.slice(open, j + 1))));
    } catch {
      // not a JSON resource: ignore
    }
  }
  return out;
}

/** The certificate search result: { rows: { Mixed: [ { Tkdn: {...} }, ... ] }, total: n }. */
function findSearch(resources) {
  for (const r of resources) {
    const ok = r && r.Ok;
    if (ok && typeof ok === 'object' && ok.rows && typeof ok.rows === 'object' && !Array.isArray(ok.rows)) return ok;
  }
  return null;
}

function rowsOf(search) {
  const out = [];
  for (const list of Object.values(search.rows)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const kind = Object.keys(item)[0];
      const data = item[kind];
      if (data && typeof data === 'object') out.push({ kind, data });
    }
  }
  return out;
}

function toRecord({ kind, data }) {
  const rec = { kind };
  for (const [k, v] of Object.entries(data)) rec[k] = typeof v === 'string' ? decodeEntities(v) : v;
  return rec;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const firstUrl = `${BASE}?q=${encodeURIComponent(name)}&by=perusahaan`;
  const want = normalize(name);
  if (!want) return fail('other', firstUrl, 'the name has no letters or digits to search for');

  const started = Date.now();
  try {
    const records = [];
    let total = null;
    let rowsSeen = 0;
    let note = '';

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > START_NEW_PAGE_BEFORE_MS) { note = ' (stopped early: time limit)'; break; }
      const url = page === 1 ? firstUrl : `${firstUrl}&page=${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        if (page === 1) return fail('blocked', url, `HTTP ${res.status}`);
        note = ` (page ${page} refused: HTTP ${res.status}; records so far kept)`;
        break;
      }
      if (!res.ok) {
        if (page === 1) return fail('http_error', url, `HTTP ${res.status}`);
        note = ` (page ${page} gave HTTP ${res.status}; records so far kept)`;
        break;
      }
      const html = await res.text();
      const search = findSearch(decodeResources(html));
      if (!search) {
        if (/captcha|cf-chl|Just a moment/i.test(html)) return fail('blocked', url, 'bot check page');
        if (page === 1) return fail('layout_changed', url, html.slice(0, 300));
        note = ` (page ${page} had no result data; records so far kept)`;
        break;
      }

      const rows = rowsOf(search);
      total = typeof search.total === 'number' ? search.total : total;
      rowsSeen += rows.length;
      const hits = rows.filter((r) => normalize(r.data.company_name) === want);
      for (const h of hits) records.push(toRecord(h));

      if (rows.length < PAGE_SIZE || hits.length === 0) break;
      if (total !== null && page * PAGE_SIZE >= total) break;
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${records.length} certificate row(s) for "${records[0].company_name}"; search total ${total}${note}`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 rows named "${name}" among ${rowsSeen} rows read (search total ${total})${note}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', firstUrl, String(err?.message || err).slice(0, 300));
  }
}
