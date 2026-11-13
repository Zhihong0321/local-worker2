export const meta = {
  task: 'CA-apps.cra-arc.gc.ca',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'bn', 'status', 'status_effective_date', 'city', 'province'],
  canary: {
    found: 'THE CANADIAN RED CROSS SOCIETY LA SOCIÉTÉ CANADIENNE DE LA CROIX-ROUGE',
    not_found: 'ORGANISME FANTOME ZZQX INEXISTANT',
  },
};

// The public Basic Search page calls this JSON endpoint without any captcha (the hCaptcha gate is only on
// the detail pages). One GET per results page; 100 rows per page, at most 5 pages are read.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_URL = 'https://apps.cra-arc.gc.ca/ebci/hacc/srch/pub/dsplyBscSrch';
const API = 'https://apps.cra-arc.gc.ca/ebci/hacc/ngcids/rest/api/cidsRequest/retrieveBasicSearchResult';
const MAX_PAGES = 5;
const LEGAL_FORMS = new Set(['INC', 'INCORPORATED', 'LTD', 'LIMITED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LLC', 'LP', 'LLP']);
const FR_ARTICLES = new Set(['LA', 'LE', 'LES', 'L']);

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Search text: the keyword without commas/periods and without a trailing legal form (INC, LTD, ...). */
function queryText(keyword) {
  const words = String(keyword || '').replace(/[.,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(stripAccents(words[words.length - 1]).toUpperCase())) words.pop();
  return words.join(' ');
}

/** Normalised tokens for comparing names: no accents, no punctuation, no leading THE, no trailing legal form. */
function matchKey(name) {
  let t = stripAccents(name).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (t.length > 1 && t[0] === 'THE') t = t.slice(1);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t;
}

/** Same company: the names are equal, or the listing is bilingual and the keyword is its first-language part. */
function sameCompany(kwTokens, recTokens) {
  if (kwTokens.length === 0 || recTokens.length === 0) return false;
  if (kwTokens.join(' ') === recTokens.join(' ')) return true;
  const n = kwTokens.length;
  return recTokens.length > n && kwTokens.every((t, i) => recTokens[i] === t) && FR_ARTICLES.has(recTokens[n]);
}

function toRecord(r) {
  const bn = r.bnNumber || {};
  return {
    name: r.orgName || '',
    bn: [bn.BNRoot, bn.ProgramID, bn.BNProgramAccountReferenceNumber].filter(Boolean).join(''),
    status: (r.status && (r.status.englishText || r.status.frenchText)) || '',
    status_effective_date: String(r.statusEffectiveDate || '').slice(0, 10),
    city: r.city || '',
    province: r.provinceStateCode || '',
  };
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let sourceUrl = PAGE_URL;
  try {
    const q = queryText(keyword);
    const kwTokens = matchKey(keyword);
    if (!q || kwTokens.length === 0) return fail('other', PAGE_URL, 'empty company name');

    const matches = [];
    let total = 0;
    let fetched = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${API}?${new URLSearchParams({ 'q.srchNmFltr': q, lng: 'eng', srcTyp: 'bscSrch', dsrdPg: String(page) })}`;
      if (page === 1) sourceUrl = url;

      let res;
      try {
        res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Referer': PAGE_URL,
          },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return fail('timeout', url, 'no answer within 25 s');
        return fail('other', url, String(err?.message || err));
      }

      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!json || !Array.isArray(json.result) || typeof json.totalCount !== 'number') {
        const low = text.slice(0, 5000).toLowerCase();
        if (low.includes('captcha')) return fail('blocked', url, 'captcha page');
        return fail('layout_changed', url, text.slice(0, 300));
      }

      total = json.totalCount;
      for (const r of json.result) {
        if (sameCompany(kwTokens, matchKey(r.orgName || ''))) matches.push(toRecord(r));
      }
      fetched += json.result.length;
      if (json.result.length === 0 || fetched >= total) break;
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: matches.map((m) => `${m.name} | BN ${m.bn} | ${m.status}`).join('; ').slice(0, 500),
      };
    }
    if (total > fetched) {
      return fail('other', sourceUrl, `${total} results for "${q}", only ${fetched} checked`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `Site returned ${total} result(s) for "${q}"; none matches "${keyword}"`,
    };
  } catch (err) {
    return fail('other', sourceUrl, String(err?.message || err));
  }
}
