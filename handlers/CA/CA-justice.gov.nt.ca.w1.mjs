export const meta = { task: 'CA-justice.gov.nt.ca', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'file_no', 'entity_type', 'jurisdiction', 'name_type', 'status'],
  canary: { found: 'BUFFALO PARCEL COURIER SERVICES LTD.', not_found: 'ᓄᓇᕗᑦ ᐊᓕᒃ ᑕᕐᒥ' } };

// CROS (Corporate Registries Online System) guest search: plain GET, no login, no captcha.
// Results come back on one page with name, entity type, file no., jurisdiction, name type and status.
const SEARCH = 'https://www.justice.gov.nt.ca/app/cros-rsel/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that the site may or may not write at the end of a name.
const LEGAL = new Set(['LTD', 'LTEE', 'LIMITED', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY',
  'LLC', 'LLP', 'LP', 'PLLC', 'LTE']);

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function cellText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Upper-case, accents removed, '&' read as 'and', punctuation dropped, legal form and leading/trailing 'THE' removed. */
function canon(str) {
  let words = (str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/&/g, ' AND ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (words[0] === 'THE' && words.length > 1) words.shift();
  while (words.length > 1 && (LEGAL.has(words[words.length - 1]) || words[words.length - 1] === 'THE')) words.pop();
  return words.join(' ');
}

/** The search term: the name as typed, without a trailing legal form (the site search matches text inside names). */
function searchTerm(keyword) {
  const words = keyword.trim().split(/\s+/);
  while (words.length > 1 && LEGAL.has(words[words.length - 1].replace(/[.,]/g, '').toUpperCase())) words.pop();
  return words.join(' ');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function lookupOnce(keyword) {
  try {
    const input = String(keyword || '').trim();
    if (!input) return fail('other', SEARCH, 'empty company name');

    const term = searchTerm(input);
    const url = `${SEARCH}?${new URLSearchParams({ search_name: term, reference: '' }).toString()}`;

    const res = await fetch(url, {
      // 'Connection: close' stops a kept-alive socket from crashing Node's exit on Windows (libuv assertion, exit 127).
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);
    if (/\/login/i.test(new URL(res.url).pathname)) return fail('blocked', res.url, 'redirected to the login page');

    const html = await res.text();
    if (/captcha|cf-chl|access denied/i.test(html)) return fail('blocked', url, 'bot or captcha page');
    if (!/Corporate Registries Online System|CROS/.test(html)) return fail('layout_changed', url, html.slice(0, 300));

    if (/No matching entities found/i.test(html)) {
      return { status: 'not_found', reason: '', records: [], source_url: url,
               excerpt: `No matching entities found for "${term}"` };
    }
    if (/More than 200 entities found/i.test(html)) {
      return fail('other', url, `site says more than 200 entities match "${term}"; the name needs to be more specific`);
    }

    const countMatch = html.match(/(\d+)\s+entit(?:y|ies)\s+found/i);
    if (!countMatch) return fail('layout_changed', url, 'no result count on the page');

    const rows = html.match(/<tr class="[^"]*company[^"]*"[\s\S]*?<\/tr>/g) || [];
    const field = (row, key) => {
      const m = row.match(new RegExp(`class="view company-${key} ?"[^>]*>([\\s\\S]*?)</span>`));
      return m ? cellText(m[1]) : '';
    };
    const all = rows.map((row) => ({
      name: field(row, 'name'),
      file_no: field(row, 'fileno'),
      entity_type: field(row, 'entity-type-translated'),
      jurisdiction: field(row, 'jurisdiction'),
      name_type: field(row, 'name-type'),
      status: field(row, 'real-status'),
    })).filter((r) => r.name);

    if (all.length === 0) return fail('layout_changed', url, `page says ${countMatch[0]} but no rows were read`);

    const target = canon(input);
    const records = all.filter((r) => canon(r.name) === target);

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: url,
               excerpt: `${all.length} similar entities returned for "${term}", none with the name "${input}"` };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: records.map((r) => `${r.name} | ${r.entity_type} | file ${r.file_no} | ${r.jurisdiction} | ${r.status}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, SEARCH, String(err?.message || err));
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the finished socket close before the worker's process.exit(): on Windows, exiting straight after a
  // kept-alive fetch crashes Node with a libuv assertion (exit 127) even though the answer was printed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}
