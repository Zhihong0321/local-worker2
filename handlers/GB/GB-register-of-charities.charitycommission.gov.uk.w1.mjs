export const meta = {
  task: 'GB-register-of-charities.charitycommission.gov.uk',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'charity_number', 'status', 'income', 'reporting', 'detail_url'],
  canary: { found: 'DEREK STUCKEY CHARITY', not_found: 'ZZQX NONEXISTENT TRADING LTD' },
};

// Charity Commission register search. The search page is server-rendered HTML: a GET with the words in the path,
// wrapped in double quotes so the site matches the phrase. Results are one table row per charity.
const BASE = 'https://register-of-charities.charitycommission.gov.uk/en/charity-search/-/results';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELTA = 100; // rows per page the site accepts
const LEGAL_FORMS = ['LIMITED', 'LTD', 'PLC', 'LLP', 'CIC', 'CIO', 'INC', 'INCORPORATED', 'CO', 'COMPANY'];

/**
 * Normalised name. forKey = true: upper case, "&" as AND, apostrophes removed, punctuation removed (used to compare
 * names). forKey = false: the phrase sent to the site search (keeps apostrophes, which the site needs to match).
 * Both drop a leading "THE" and a trailing legal form.
 */
function core(str, forKey) {
  let s = String(str || '').toUpperCase().replace(/&/g, forKey ? ' AND ' : ' ');
  s = forKey ? s.replace(/['’]/g, '') : s.replace(/’/g, "'");
  s = s.replace(forKey ? /[^\p{L}\p{N}]+/gu : /[^\p{L}\p{N}']+/gu, ' ').trim();
  let w = s.split(' ').filter(Boolean);
  if (w.length > 1 && w[0] === 'THE') w = w.slice(1);
  while (w.length > 1 && LEGAL_FORMS.includes(w[w.length - 1])) w = w.slice(0, -1);
  return w.join(' ');
}

/** Visible text of an HTML fragment. */
function clean(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One object per result row: charity number, name, status, income, reporting, detail page. */
function parseRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*id="[^"]*search-result-entries_\d+"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 5) continue;
    const link = cells[1].match(/href="([^"]*charity-details\/[^"]*)"/);
    rows.push({
      charity_number: clean(cells[0]),
      name: clean(cells[1]),
      status: clean(cells[2]),
      income: clean(cells[3]),
      reporting: clean(cells[4]),
      detail_url: link ? clean(link[1]) : '',
    });
  }
  return rows;
}

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const phrase = core(keyword, false);
    const wanted = core(keyword, true);
    if (!wanted) return answer('couldnt_check', 'other', [], '', 'empty company name');

    searchUrl = `${BASE}/page/1/delta/${DELTA}/keywords/${encodeURIComponent(`"${phrase}"`)}`;
    const res = await fetch(searchUrl, {
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return answer('couldnt_check', 'blocked', [], searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return answer('couldnt_check', 'http_error', [], searchUrl, `HTTP ${res.status}`);
    }

    const html = await res.text();
    if (!html.includes('search-result-entries')) {
      return answer('couldnt_check', 'layout_changed', [], searchUrl, clean(html).slice(0, 300));
    }

    const rows = parseRows(html);
    const shown = html.match(/of\s+([\d,]+)\s+items/);
    const total = shown ? Number(shown[1].replace(/,/g, '')) : rows.length;

    const matches = rows.filter((r) => core(r.name, true) === wanted);
    if (matches.length) {
      const first = matches[0];
      return answer(
        'found',
        '',
        matches.map((r) => ({
          name: r.name,
          charity_number: r.charity_number,
          status: r.status,
          income: r.income,
          reporting: r.reporting,
          detail_url: r.detail_url,
        })),
        searchUrl,
        `${first.name} | charity number ${first.charity_number} | ${first.status} | income ${first.income} | ${first.reporting}`,
      );
    }

    // No exact name in the rows we have. Only a complete list can prove the company is absent.
    if (total > rows.length) {
      return answer(
        'couldnt_check',
        'other',
        [],
        searchUrl,
        `search for "${phrase}" has ${total} results and the first ${rows.length} do not contain the name`,
      );
    }
    return answer('not_found', '', [], searchUrl, `no charity named "${phrase}" among ${total} result(s)`);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return answer(
      'couldnt_check',
      timedOut ? 'timeout' : 'other',
      [],
      searchUrl || BASE,
      String(err?.message || err),
    );
  }
}
