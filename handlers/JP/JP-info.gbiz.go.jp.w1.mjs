export const meta = { task: 'JP-info.gbiz.go.jp', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'corporate_number', 'address', 'capital', 'employees', 'closed'],
  canary: { found: 'トヨタ自動車株式会社', not_found: 'ヮヵヶヷヸヹ' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_URL = 'https://info.gbiz.go.jp/hojin/FreewordSearch';
const PROFILE_URL = 'https://info.gbiz.go.jp/hojin/ichiran?hojinBango=';
const PAGE_SIZE = 50;
const MAX_PAGES = 6;          // up to 300 hits checked
const START_NEW_FETCH_BEFORE_MS = 30000; // keep the whole call under 60 s

// Legal-form words, after NFKC (㈱ becomes (株)). Removed before comparing names.
const LEGAL_RE = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|独立行政法人|\(株\)|\(有\)|\(同\)|\(合\)|\(名\)|\(相\)/g;

/** Normalised company core: NFKC, lower case, no legal form, no spaces or punctuation. */
function core(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/\(閉鎖\)/g, '')
    .replace(LEGAL_RE, '')
    .replace(/[\s.,、。・\-_()\[\]'"`]/g, '');
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Result rows of one search page: one object per company link. */
function rowsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tr = m[1];
    const link = tr.match(/submitProfile\(&#39;(\d{13})&#39;\);"><span>([\s\S]*?)<\/span>/);
    if (!link) continue;
    const field = (cls) => {
      const f = tr.match(new RegExp(`<span class="${cls}">([\\s\\S]*?)<\\/span>`));
      return f ? cleanText(f[1]) : '';
    };
    const rawName = cleanText(link[2]);
    out.push({
      corporate_number: link[1],
      name: rawName.replace(/\(閉鎖\)$/, '').trim(),
      closed: /\(閉鎖\)$/.test(rawName),
      search_address: field('address'),
      capital: field('capital'),
      employees: field('employee'),
    });
  }
  return out;
}

function searchBody(keyword, page) {
  return new URLSearchParams({
    activeSearchTab: 'freeword', gamenSeniFlg: 'false', gamen: '1',
    searchTypeHidden: page > 1 ? 'changePage' : '', pageHidden: String(page),
    sortKeyHidden: 'corporateName', sortTypeHidden: 'up',
    pageKensuHidden: String(PAGE_SIZE), pageNumsHidden: '1',
    suggestWord: '', searchWord: keyword,
  });
}

/** Head-office address and page title from the company profile page. Best effort. */
async function profileOf(num) {
  const res = await fetch(PROFILE_URL + num, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const label = html.indexOf('本店所在地');
  let address = '';
  if (label >= 0) {
    const end = html.indexOf('</div>', label);
    address = cleanText(html.slice(label + 5, end > label ? end : label + 600)).split(/[（(]/)[0].trim();
  }
  return { title, address, has_number: html.includes(num) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const want = core(kw);
  const started = Date.now();
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: SEARCH_URL, excerpt: String(excerpt).slice(0, 300) });
  if (!want) return fail('other', 'keyword has no company-name part');

  try {
    let total = 0;
    let pages = 1;
    const matches = [];

    for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > START_NEW_FETCH_BEFORE_MS) return fail('timeout', 'search ran past 30 s');

      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/html,*/*;q=0.8' },
        body: searchBody(kw, page),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

      const html = await res.text();
      const countM = html.match(/<span>([\d,]+)<\/span>\s*件中/);
      const nodata = html.includes('該当データがありません');

      if (!countM && !nodata) {
        return fail(/captcha/i.test(html) ? 'blocked' : 'layout_changed', html.slice(0, 200));
      }
      if (nodata && !countM) {
        return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL, excerpt: `0 results for ${kw}` };
      }

      total = parseInt(countM[1].replace(/,/g, ''), 10);
      pages = Math.ceil(total / PAGE_SIZE);
      for (const row of rowsOf(html)) {
        // The site's paging can repeat a row on a later page, so one company is kept once.
        if (core(row.name) === want && !matches.some((m) => m.corporate_number === row.corporate_number)) matches.push(row);
      }
    }

    if (matches.length === 0) {
      // Only a zero-hit answer, or a short list that was read in full, can say "not listed".
      // Longer lists are paged, and the site's paging repeats or skips rows, so they cannot prove absence.
      if (total === 0) return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL, excerpt: `0 results for ${kw}` };
      if (total <= PAGE_SIZE) return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL, excerpt: `${total} search hits for ${kw}, none with this name` };
      return fail('other', `${total} search hits, no exact name on the ${Math.min(pages, MAX_PAGES)} pages checked; paging is not stable enough to call it not listed`);
    }

    // Enrich the first few matches with the profile page (head-office address). Search rows are the fallback.
    const records = [];
    for (const [i, row] of matches.entries()) {
      let address = row.search_address;
      if (i < 3 && Date.now() - started < START_NEW_FETCH_BEFORE_MS) {
        const prof = await profileOf(row.corporate_number);
        if (prof && prof.has_number && prof.address) address = prof.address;
      }
      records.push({ name: row.name, corporate_number: row.corporate_number, address, capital: row.capital, employees: row.employees, closed: row.closed });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: PROFILE_URL + matches[0].corporate_number,
      excerpt: `${total} search hits for ${kw}; exact match: ${matches.map((r) => `${r.name} (${r.corporate_number})`).join(', ')}`.slice(0, 300),
    };
  } catch (err) {
    return fail('other', String(err?.message || err));
  }
}
