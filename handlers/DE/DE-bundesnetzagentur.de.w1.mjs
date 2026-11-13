export const meta = {
  task: 'DE-bundesnetzagentur.de',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'matched_on', 'register_number','postcode', 'city', 'street', 'country', 'formal_delivery', 'registered_on'],
  canary: { found: 'DPD Deutschland GmbH', not_found: 'Zzqx Brieftaubenversand Nordlicht GmbH' },
};

// Bundesnetzagentur "Anbieterverzeichnis" (postal service providers). The whole register is one static HTML table
// (about 8,300 rows); the site's own "Firma" filter runs in the browser, so the handler fetches the table once and
// matches the name locally. The page is ~3 MB uncompressed but ~400 KB gzipped, which is why Accept-Encoding is set.
const PAGE_URL =
  'https://www.bundesnetzagentur.de/DE/Fachthemen/Post/Anbieterverzeichnis/PostAnbieterverzeichnis.html?nn=1097982';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// German legal-form tokens that are ignored when comparing names ("GmbH", "AG", "GmbH & Co. KG", "e.K.", ...).
const LEGAL_TOKENS = new Set(['gmbh', 'ag', 'kg', 'ohg', 'ug', 'gbr', 'se', 'mbh', 'kgaa', 'co', 'ek']);

function decodeHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparison key: lower case, German umlauts folded, legal form removed, punctuation and spaces removed. */
function nameKey(str) {
  const folded = (str || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\be\.\s*k\.?/g, ' ek ');
  return folded
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LEGAL_TOKENS.has(t))
    .join('');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = nameKey(keyword);
    if (!key) return fail('other', PAGE_URL, 'the company name has no usable characters');

    const res = await fetch(PAGE_URL, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', PAGE_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', PAGE_URL, `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|access denied|zugriff verweigert/i.test(html) && !html.includes('id="sortableTable"')) {
      return fail('blocked', PAGE_URL, html.slice(0, 300));
    }
    // The table must be complete (the page ends after the table and the document closes) or the answer could be
    // a false "not found" from a cut-off list.
    if (!html.includes('id="sortableTable"') || !html.includes('</tbody>') || !html.trimEnd().endsWith('</html>')) {
      return fail('layout_changed', PAGE_URL, html.slice(0, 300));
    }

    const rowHtml = html.match(/<tr class="datarow">[\s\S]*?<\/tr>/g) || [];
    if (rowHtml.length === 0) return fail('layout_changed', PAGE_URL, 'no provider rows found in the table');

    const records = [];
    for (const row of rowHtml) {
      const cell = {};
      for (const m of row.matchAll(/<td class="td(\d)">([\s\S]*?)<\/td>/g)) cell[m[1]] = decodeHtml(m[2]);
      const firm = cell['1'] || '';
      if (!firm) continue;
      // A row can carry a person and a trade name: "Person | Trade name". Either side may be the company.
      const matchedOn = nameKey(firm) === key ? 'full_name' : firm.split('|').some((p) => nameKey(p) === key) ? 'trade_name' : '';
      if (!matchedOn) continue;
      records.push({
        name: firm,
        matched_on: matchedOn,
        register_number: cell['0'] || '',
        postcode: cell['2'] || '',
        city: cell['3'] || '',
        street: cell['4'] || '',
        country: cell['5'] || '',
        formal_delivery: cell['6'] || '',
        registered_on: cell['7'] || '',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: `No row in the Anbieterverzeichnis (${rowHtml.length} providers checked) matches "${keyword}"`,
      };
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE_URL,
      excerpt: `${first.name} | Stammnr. ${first.register_number} | ${first.postcode} ${first.city} | ${first.street} | ${first.country} | Eintragung ${first.registered_on}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', PAGE_URL, String(err?.message || err));
  }
}
