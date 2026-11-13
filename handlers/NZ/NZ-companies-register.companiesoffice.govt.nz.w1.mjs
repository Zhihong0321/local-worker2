export const meta = {
  task: 'NZ-companies-register.companiesoffice.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_number', 'nzbn', 'status', 'entity_type', 'incorporation_date', 'registered_office', 'address', 'detail_checked'],
  canary: { found: 'FONTERRA TM LIMITED', not_found: 'Kōpū Whakaaro Pōhutu Tūhoe Limited' },
};

const BASE = 'https://app.companiesoffice.govt.nz/companies/app/ui/pages/companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-NZ,en;q=0.9',
};
const LEGAL = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co', 'lp']);
const PAGE = 100;       // rows per search page
const MAX_PAGES = 3;    // at most 300 rows read for one name
const MAX_DETAIL = 3;   // detail pages read per lookup
const NO_NEW_CALL_AFTER_MS = 30000; // a fetch started later could run past the 60 s limit

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Lower-case words without punctuation or legal-form words. */
function words(s) {
  return fold(s).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** The comparison key: normalised name with legal form removed. */
function coreKey(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join('');
}

/** The search text: the name as typed (macrons kept), minus punctuation and legal-form words. */
function searchText(s) {
  return String(s || '')
    .replace(/[.,'"()&]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL.has(fold(w).replace(/[^a-z0-9]/g, '')))
    .join(' ');
}

function decode(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One object per result row on a search page. */
function parseRows(html) {
  const rows = [];
  const re = /viewCompanyDetails\('(\d+)'\);">([\s\S]*?)<\/a>([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const inner = m[2];
    const nm = inner.match(/class="entityName">([\s\S]*?)<\/span>/);
    if (!nm) continue;
    const name = decode(nm[1]);
    const info = decode(inner.replace(/<span class="entityName">[\s\S]*?<\/span>/, ''));
    const typeM = inner.match(/class="entityType">([\s\S]*?)<\/span>/);
    const type = typeM ? decode(typeM[1]) : '';
    const nzbnM = info.match(/NZBN:\s*(\d+)/);
    const status = info
      .replace(/^\(\d+\)/, '')
      .replace(/\(NZBN:\s*\d+\)/, '')
      .replace(type, '')
      .trim();
    const address = decode(m[3].split(/<div[^>]*>/).pop());
    rows.push({ name, number: m[1], nzbn: nzbnM ? nzbnM[1] : '', status, type, address });
  }
  return rows;
}

/** Fields from a company detail page; only the labels that are present are returned. */
function parseDetail(html) {
  const t = decode(html);
  const out = {};
  const inc = t.match(/Incorporation Date:\s*(\d{1,2} [A-Za-z]{3} \d{4})/);
  if (inc) out.incorporation_date = inc[1];
  const st = t.match(/Company Status:\s*([A-Za-z][A-Za-z ]*?)\s*Entity type:/);
  if (st) out.status = st[1].trim();
  const et = t.match(/Entity type:\s*(.+?)\s*(?:Constitution filed|AR filing month)/);
  if (et) out.entity_type = et[1].trim();
  const ro = t.match(/Registered Office\s+(.+?)\s+Address for service/);
  if (ro && ro[1].length < 300) out.registered_office = ro[1].trim();
  const nz = t.match(/Company number:\s*(\d+)\s*NZBN:\s*(\d{13})/);
  if (nz) { out.company_number = nz[1]; out.nzbn = nz[2]; }
  return out;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const q = searchText(kw);
  const want = coreKey(kw);
  if (!q || !want) return fail('other', '', 'the name has no words to search for');

  let searchUrl = '';
  let total = null;
  const rows = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - started > NO_NEW_CALL_AFTER_MS) {
        return fail('timeout', searchUrl, 'more result pages were needed but the 60 s limit was near');
      }
      const start = page * PAGE;
      searchUrl = `${BASE}/search?q=${encodeURIComponent(q)}&entityTypes=ALL&entityStatusGroups=ALL` +
        `&incorporationDateFrom=&incorporationDateTo=&addressKeyword=&start=${start}&limit=${PAGE}` +
        `&advancedPanel=false&mode=standard`;
      const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) {
        return fail('blocked', searchUrl, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return fail('http_error', searchUrl, `HTTP ${res.status}`);
      }
      const html = await res.text();
      const cnt = html.match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s+results/i);
      if (!cnt) {
        if (/couldn.t find results for your exact search/i.test(html)) {
          return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
            excerpt: `The register returned no results for "${q}".` };
        }
        return fail('layout_changed', searchUrl, decode(html).slice(0, 300));
      }
      total = Number(cnt[3]);
      const end = Number(cnt[2]);
      rows.push(...parseRows(html));
      if (rows.some((r) => coreKey(r.name) === want)) break;
      if (end >= total) break;
    }
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', searchUrl, String(err && err.message || err));
  }

  if (total !== null && rows.length === 0 && total > 0) {
    return fail('layout_changed', searchUrl, `header says ${total} results but no result rows were read`);
  }

  const matches = rows.filter((r) => coreKey(r.name) === want);
  if (!matches.length) {
    if (total !== null && rows.length < total) {
      return fail('other', searchUrl, `${total} results, ${rows.length} read, no exact name match yet`);
    }
    const nearest = rows.slice(0, 3).map((r) => `${r.name} (${r.number})`).join('; ');
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `${rows.length} result(s) for "${q}", none with this company name${nearest ? ': ' + nearest : ''}` };
  }

  const records = [];
  let detailsRead = 0;
  for (const r of matches) {
    const rec = {
      name: r.name,
      company_number: r.number,
      nzbn: r.nzbn,
      status: r.status,
      entity_type: r.type,
      incorporation_date: '',
      registered_office: '',
      address: r.address,
      detail_checked: false,
    };
    if (detailsRead < MAX_DETAIL && Date.now() - started <= NO_NEW_CALL_AFTER_MS) {
      detailsRead++;
      try {
        const dres = await fetch(`${BASE}/${r.number}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (dres.ok) {
          const d = parseDetail(await dres.text());
          for (const k of Object.keys(d)) if (d[k]) rec[k] = d[k];
          rec.detail_checked = Object.keys(d).length > 0;
        }
      } catch (err) {
        // keep the search-row fields; detail_checked stays false
      }
    }
    records.push(rec);
  }

  const first = matches[0];
  return {
    status: 'found',
    reason: '',
    records,
    source_url: `${BASE}/${first.number}`,
    excerpt: records.map((r) => `${r.name} (${r.company_number}) ${r.status}`).join('; ').slice(0, 480),
  };
}
