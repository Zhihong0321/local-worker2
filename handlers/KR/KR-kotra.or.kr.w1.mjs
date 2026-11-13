export const meta = {
  task: 'KR-kotra.or.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entp_id', 'seller_url', 'registered'],
  canary: { found: 'SHINIL CO.,LTD.', not_found: '가나다라마바사 주식회사' },
};

// The company directory is BuyKorea (KOTRA's exporter directory, linked from www.kotra.or.kr).
// Its JSON name search is buykorea.org/cp/cpy/ajax/selectCpComList.do (GET works, resultCd "0000" = success).
// The kotra.or.kr unified search does not match company names, so it is not used here.
const API = 'https://buykorea.org/cp/cpy/ajax/selectCpComList.do';
const SITE = 'https://buykorea.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;
const MAX_PAGES = 10;
const DEADLINE_MS = 35000;
// Legal-form words dropped before comparing (and before searching).
const LEGAL = new Set(['co', 'ltd', 'limited', 'inc', 'corp', 'corporation', 'company', 'llc', 'llp', 'plc', 'gmbh', 'pte', 'sdn', 'bhd', 'pvt', 'kk']);

function words(name) {
  const s = String(name || '').normalize('NFKC').toLowerCase().replace(/\(주\)|주식회사|유한회사/g, ' ');
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).filter((w) => !LEGAL.has(w));
}

function compareKey(name) {
  return words(name).join('');
}

async function fetchPage(query, skip) {
  const url = new URL(API);
  url.search = new URLSearchParams({
    sortOrder: '', srchChar: '', ctgryCd: '', goodsCtgryClCd: '',
    srchStr: query, srchSkip: String(skip), srchCnt: String(PAGE),
  }).toString();
  const res = await fetch(url.href, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://buykorea.org/cp/cpy/selectCompaniesList.do',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(25000),
  });
  return { url: url.href, res };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let firstUrl = API;
  const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });
  try {
    const typed = String(keyword || '').trim();
    const want = compareKey(typed);
    if (!want) return fail('other', API, 'empty company name');
    // The site's own search asks for at least three characters; a shorter search is not a real answer.
    const query = words(typed).join(' ');
    if (query.replace(/\s/g, '').length < 3) return fail('other', API, 'the BuyKorea search needs at least 3 characters');

    const matches = [];
    let total = 0;
    let skip = 0;
    let pages = 0;
    let complete = false;
    let stop = '';

    for (;;) {
      if (Date.now() - started > DEADLINE_MS) { stop = 'timeout'; break; }
      if (pages >= MAX_PAGES) { stop = 'other'; break; }
      const { url, res } = await fetchPage(query, skip);
      if (pages === 0) firstUrl = url;
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };

      const text = await res.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        const blocked = /captcha|robot|access denied|forbidden/i.test(text);
        return fail(blocked ? 'blocked' : 'layout_changed', url, text.slice(0, 200));
      }
      if (j && j.resultCd !== undefined && j.resultCd !== '0000') {
        return fail('other', url, `resultCd=${j.resultCd} ${String(j.resultMsg || '').slice(0, 100)}`);
      }
      if (!j || !Array.isArray(j.comList) || j.totCnt === undefined) {
        return fail('layout_changed', url, text.slice(0, 200));
      }
      total = Number(j.totCnt);
      for (const c of j.comList) {
        if (compareKey(c.engEntpName) === want) matches.push(c);
      }
      pages += 1;
      skip += PAGE;
      if (skip >= total || j.comList.length === 0) { complete = true; break; }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((c) => ({
          name: c.engEntpName,
          entp_id: c.entpId,
          seller_url: new URL(c.entpUrl, SITE).href,
          registered: c.regDt ? new Date(c.regDt).toISOString().slice(0, 10) : '',
        })),
        source_url: firstUrl,
        excerpt: `BuyKorea lists ${matches.map((c) => c.engEntpName).join('; ')} (search returned ${total} rows)`.slice(0, 500),
      };
    }
    if (!complete) {
      return fail(stop || 'other', firstUrl, `read ${pages} page(s) of ${total} rows; no exact match yet`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `BuyKorea search for "${query}" returned ${total} rows; none is "${typed}"`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', firstUrl, String(err?.message || err).slice(0, 300));
  }
}
