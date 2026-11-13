export const meta = {
  task: 'TH-sec.or.th', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name_th', 'name_en', 'kind', 'comp_run_code', 'telephone', 'issuer_status', 'punishment', 'licence_details',
    'register_types', 'alert_message', 'alert_from', 'alert_to', 'detail_url'],
  canary: { found: 'ธนาคารกรุงเทพ จำกัด (มหาชน)', not_found: 'บริษัท ทดสอบไม่มีอยู่จริง จำกัด' },
};

// SEC Thailand "SEC Check First" licence search (market.sec.or.th/LicenseCheck/Search). The page calls a JSON API;
// the API needs the session cookie that the search page sets, so the handler loads the page first, like a browser.
const BASE = 'https://market.sec.or.th';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // 10 rows per page, so at most 50 rows are scanned
const START_NEW_FETCH_BEFORE_MS = 30000; // every fetch can take up to 25 s; stay under the 60 s limit

// Legal-form words, removed before comparing names. The site's search returns HTTP 500 when the legal form is sent,
// so the search uses the same core name.
const LEGAL = /บริษัท|จำกัด|มหาชน|public\s+company\s+limited|company\s+limited|\bco\b\.?|\bltd\b\.?|\blimited\b|\bpcl\b\.?|\bplc\b\.?|\bsdn\.?\s*bhd\.?|\bbhd\b\.?|\binc\b\.?|\bcorp\b\.?|\bcompany\b/gi;

function core(s) {
  return String(s || '').replace(LEGAL, ' ').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function validDate(s) {
  return !s || String(s).startsWith('0001') ? '' : String(s).slice(0, 10);
}

function toRecord(o) {
  const isAlert = !!o.IsInvesterAlert;
  const kind = isAlert ? 'investor_alert' : (o.Comp_Run_Code ? 'licensed_company' : 'other');
  let detailUrl = '';
  if (isAlert && o.InvesterAlertCaseID) detailUrl = `https://web-invpublic.sec.or.th/t/${o.InvesterAlertCaseID}/${o.InvesterAlertCaseYY}`;
  else if (o.LinkViewMore) detailUrl = o.LinkViewMore;
  else if (o.Comp_Run_Code) detailUrl = `${BASE}/LicenseCheck/CompanyDetail/${o.Comp_Run_Code}`;
  const texts = (arr) => (Array.isArray(arr) ? arr.map((d) => d.Detail_TH || d.Detail_EN || '').filter(Boolean) : []);
  return {
    name_th: o.Name_TH || '',
    name_en: o.Name_EN || '',
    kind,
    comp_run_code: o.Comp_Run_Code || '',
    telephone: o.Telephone || '',
    issuer_status: o.IsIssuerDesc || '',
    punishment: o.IsPunishment ? (o.PunishmentDesc || 'yes') : '',
    licence_details: texts(o.Details),
    register_types: texts(o.RegisterTypeList).concat(texts(o.RegisterType2List)),
    alert_message: o.AlertMessage_TH || '',
    alert_from: validDate(o.AlertFromDate),
    alert_to: validDate(o.AlertToDate),
    detail_url: detailUrl,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const start = Date.now();
  const kw = String(keyword || '').trim();
  const key = core(kw);
  const term = kw.replace(LEGAL, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const searchUrl = (p) => `${BASE}/LicenseCheck/api/LicenseCheck/SearchCompany?` +
    new URLSearchParams({ strSearch: term, clid: '', lang: 'th', pageNumber: String(p) }).toString();
  const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) });

  try {
    if (!key) return fail('other', BASE + '/LicenseCheck/Search', 'the name has no words to search for');

    // 1. The search page: sets the session cookie the API needs.
    const page = await fetch(`${BASE}/LicenseCheck/Search`, {
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'th-TH,th;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    const pageText = await page.text();
    if (page.status === 403 || page.status === 429 || /Block Response|captcha/i.test(pageText)) {
      return fail('blocked', `${BASE}/LicenseCheck/Search`, `HTTP ${page.status} on the search page`);
    }
    if (!page.ok) return fail('http_error', `${BASE}/LicenseCheck/Search`, `HTTP ${page.status} on the search page`);
    const cookie = (page.headers.getSetCookie ? page.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

    // 2. The search API, one page of 10 rows at a time.
    const searchPage = async (p) => {
      let last = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1 && Date.now() - start > 20000) break; // a retry only if there is time for it
        let r;
        try {
          r = await fetch(searchUrl(p), {
          headers: {
            'user-agent': UA,
            'accept': 'application/json, text/javascript, */*; q=0.01',
            'accept-language': 'th-TH,th;q=0.9,en;q=0.8',
            'x-requested-with': 'XMLHttpRequest',
            'referer': `${BASE}/LicenseCheck/Search`,
            ...(cookie ? { cookie } : {}),
          },
          signal: AbortSignal.timeout(25000),
          });
        } catch (err) {
          const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
          last = { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err && err.message ? err.message : err) };
          continue;
        }
        const body = await r.text();
        if (r.status === 403 || r.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${r.status}` };
        if (r.ok) {
          let json = null;
          try { json = JSON.parse(body); } catch { /* fall through */ }
          if (!json || typeof json.CountRows !== 'number' || !Array.isArray(json.SearchResult)) {
            return { ok: false, reason: 'layout_changed', excerpt: body.slice(0, 300) };
          }
          return { ok: true, json };
        }
        last = { ok: false, reason: 'http_error', excerpt: `HTTP ${r.status}: ${body.slice(0, 200)}` };
        if (r.status < 500) break; // only 5xx is retried
      }
      return last;
    };

    const matches = [];
    const seen = new Set();
    let total = 0;
    let scanned = 0;
    let pageErr = null;
    for (let p = 1; p <= MAX_PAGES; p++) {
      if (p > 1 && (p - 1) * 10 >= total) break;
      if (p > 1 && Date.now() - start > START_NEW_FETCH_BEFORE_MS) {
        pageErr = { reason: 'timeout', excerpt: `stopped before page ${p} to stay under 60 s` };
        break;
      }
      const res = await searchPage(p);
      if (!res.ok) { pageErr = res; break; }
      total = res.json.CountRows;
      scanned = p;
      for (const row of res.json.SearchResult) {
        if (!key) continue;
        if (core(row.Name_TH) !== key && core(row.Name_EN) !== key) continue;
        const rec = toRecord(row);
        const id = `${rec.kind}|${rec.comp_run_code}|${rec.name_th}|${rec.detail_url}`;
        if (seen.has(id)) continue;
        seen.add(id);
        matches.push(rec);
      }
      if (matches.length === 0 && total === 0) break;
    }

    const shownUrl = searchUrl(1);
    if (matches.length > 0) {
      const names = matches.map((m) => m.name_th).join(' | ');
      return {
        status: 'found', reason: '', records: matches, source_url: shownUrl,
        excerpt: `${matches.length} matching record(s) for "${kw}": ${names}` + (pageErr ? ` (later page not read: ${pageErr.reason})` : ''),
      };
    }
    if (pageErr) return fail(pageErr.reason, shownUrl, pageErr.excerpt);
    if (total > scanned * 10) {
      return fail('other', shownUrl, `search for "${term}" returned ${total} rows; only the first ${scanned * 10} were read`);
    }
    // The site lists most companies under their Thai name. An English name can match a Thai row without equal text,
    // so rows that do not match are not proof of absence for an English name.
    if (total > 0 && !/[฀-๿]/.test(kw)) {
      return fail('other', shownUrl, `site search for "${term}" returned ${total} row(s), none equal to "${kw}"; an English name cannot be matched to Thai rows`);
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: shownUrl,
      excerpt: `site search for "${term}" returned ${total} row(s); none matches "${kw}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', `${BASE}/LicenseCheck/Search`, String(err && err.message ? err.message : err));
  }
}
