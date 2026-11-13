export const meta = {
  task: 'KR-kind.krx.co.kr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_kr', 'ticker', 'isin', 'market_type_code', 'listing_status', 'kind_company_code', 'issue_code'],
  canary: { found: '삼성전자', not_found: '가나다라마바사존재하지않는회사' },
};

const SEARCH_URL = 'https://kind.krx.co.kr/common/searchcorpname.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Remove Korean legal-form words/marks (주식회사, (주), ㈜, 유한회사, (유), ...). */
function stripLegalForm(s) {
  return (s || '')
    .replace(/\(\s*주\s*\)|\(\s*유\s*\)|\(\s*유한\s*\)|㈜|주식회사|유한책임회사|유한회사/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised form used only for comparing two names. */
function normalize(s) {
  return stripLegalForm(s).toLowerCase().replace(/[\s.,()\-·'"&]/g, '');
}

function hasHangul(s) {
  return /[ᄀ-ᇿ㄰-㆏가-힯]/.test(s || '');
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: SEARCH_URL, excerpt: String(excerpt).slice(0, 500) };
}

async function search(term) {
  const body = new URLSearchParams({ method: 'searchCorpNameJson', searchCorpName: term, searchCodeType: 'char' });
  return fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://kind.krx.co.kr/',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const typed = String(keyword ?? '').replace(/\s+/g, ' ').trim();
    const core = stripLegalForm(typed);
    if (!core) return couldnt('other', 'empty company name after removing the legal form');
    // KIND indexes Korean company names only, so a name with no Hangul cannot be checked here.
    if (!hasHangul(core)) {
      return couldnt('other', `KIND indexes Korean company names only; "${typed}" has no Hangul, so it cannot be searched here`);
    }

    // The site matches whole names exactly and does not strip legal forms, so search the bare name first.
    const terms = [...new Set([core, typed.replace(/\s+/g, '')])];
    const target = normalize(core);

    let matches = [];
    let matchedTerm = '';
    for (const term of terms) {
      const res = await search(term);
      if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

      const text = (await res.text()).trim();
      if (!text) return couldnt('layout_changed', 'empty response body');
      if (!text.startsWith('[')) {
        // A login, captcha or bot page comes back as HTML, not as the JSON list.
        const looksBlocked = /captcha|로그인|login|차단|접근이\s*제한/i.test(text.slice(0, 3000));
        return couldnt(looksBlocked ? 'blocked' : 'layout_changed', text.slice(0, 300));
      }

      let rows;
      try { rows = JSON.parse(text); } catch { return couldnt('layout_changed', 'response is not valid JSON'); }
      if (!Array.isArray(rows)) return couldnt('layout_changed', 'response JSON is not a list');

      matches = rows.filter((r) => r && typeof r === 'object' &&
        (normalize(r.comabbrv) === target || normalize(r.repisusrtkornm) === target));
      if (matches.length) { matchedTerm = term; break; }
    }

    const seen = new Set();
    const records = [];
    for (const r of matches) {
      const key = `${r.isurcd}|${r.repisusrtcd2}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        name: r.comabbrv || '',
        name_kr: r.repisusrtkornm || '',
        ticker: r.repisusrtcd2 || '',
        isin: r.repisucd || '',
        market_type_code: r.spotisutrdmkttpcd || '',
        listing_status: r.liststatcd || '',
        kind_company_code: r.kiscomcd || '',
        issue_code: r.isurcd || '',
      });
    }

    if (!records.length) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: `KIND name search returned no exact match for "${core}"`,
      };
    }

    return {
      status: 'found', reason: '', records, source_url: SEARCH_URL,
      excerpt: `KIND name search "${matchedTerm}": ${JSON.stringify(records[0])}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
