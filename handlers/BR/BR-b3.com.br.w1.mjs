export const meta = {
  task: 'BR-b3.com.br',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'trading_name', 'cnpj', 'code_cvm', 'ticker', 'status', 'segment', 'market', 'market_indicator', 'date_listing'],
  canary: { found: 'PETROLEO BRASILEIRO S.A. PETROBRAS', not_found: 'EMPRESA INEXISTENTE XYZ LTDA' },
};

// B3 "Empresas Listadas" search: the Angular page calls this JSON endpoint with a base64-encoded JSON filter.
const API = 'https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetInitialCompanies/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const STOP_AFTER_MS = 50000; // the whole call must finish in under 60 s
const LEGAL_TAIL = new Set(['sa', 's', 'a', 'ltda', 'eireli', 'me', 'epp', 'ss', 'slu']);

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** lower-case words, no accents, no punctuation */
function words(name) {
  return stripAccents(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** words without a trailing legal form (S.A., S/A, LTDA, ...) */
function coreWords(name) {
  const w = words(name);
  while (w.length > 1 && LEGAL_TAIL.has(w[w.length - 1])) w.pop();
  return w;
}

/** comparison key: no case, accents, punctuation, spaces or legal form */
function key(name) {
  return coreWords(name).join('');
}

/** base64 of UTF-8 text, the same encoding the site's own page uses for its filter */
function b64utf8(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function toRecord(r) {
  return {
    name: r.companyName || '',
    trading_name: r.tradingName || '',
    cnpj: r.cnpj || '',
    code_cvm: r.codeCVM || '',
    ticker: r.issuingCompany || '',
    status: r.status || '',
    segment: r.segment || '',
    market: r.market || '',
    market_indicator: r.marketIndicator || '',
    date_listing: r.dateListing || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const input = String(keyword ?? '').trim().replace(/\s+/g, ' ');
    if (!key(input)) {
      return couldnt('other', '', 'the name has no Latin letters or digits to match on');
    }

    // The site searches by substring. Try the name as typed, then without accents, then the bare name.
    const terms = [...new Set([input, stripAccents(input), coreWords(input).join(' ')].filter(Boolean))];

    const seen = new Map(); // one entry per listed company seen in any result page
    let truncated = false;
    let lastUrl = '';

    for (const term of terms) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const elapsed = Date.now() - started;
        if (elapsed > STOP_AFTER_MS) {
          return couldnt('timeout', lastUrl, `stopped after ${Math.round(elapsed / 1000)} s to stay under 60 s`);
        }

        const payload = { language: 'pt-br', pageNumber: page, pageSize: PAGE_SIZE, company: term };
        const url = API + b64utf8(JSON.stringify(payload));
        const timeoutMs = Math.max(1000, Math.min(25000, 55000 - elapsed));

        const res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://sistemaswebb3-listados.b3.com.br/listedCompaniesPage/',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 403 || res.status === 429) {
          return couldnt('blocked', url, `HTTP ${res.status}`);
        }
        if (!res.ok) {
          return couldnt('http_error', url, `HTTP ${res.status}`);
        }

        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        if (!data || !Array.isArray(data.results) || !data.page) {
          if (/captcha|challenge|cf-chl|access denied/i.test(text)) {
            return couldnt('blocked', url, text.slice(0, 200));
          }
          return couldnt('layout_changed', url, text.slice(0, 300));
        }

        lastUrl = url;
        for (const r of data.results) {
          const k = `${r.codeCVM}|${r.cnpj}|${r.companyName}`;
          if (!seen.has(k)) seen.set(k, { r, url });
        }

        const totalPages = Number(data.page.totalPages) || 0;
        if (page >= totalPages) break;
        if (page === MAX_PAGES) truncated = true;
      }
    }

    // Match the company, not similar words: same name or same trading name, after normalising.
    const want = key(input);
    const matches = [...seen.values()].filter(({ r }) => key(r.companyName) === want || key(r.tradingName) === want);

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(({ r }) => toRecord(r)),
        source_url: matches[0].url,
        excerpt: JSON.stringify(toRecord(matches[0].r)).slice(0, 300),
      };
    }

    if (truncated) {
      return couldnt('other', lastUrl, `no exact match in the first ${MAX_PAGES} pages of ${PAGE_SIZE} results; the search is too broad to check fully`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `0 listed companies match "${input}" (${seen.size} search results checked, none with that name)`,
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, API, String(err?.message || err));
  }
}
