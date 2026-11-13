export const meta = { task: 'IN-acma.in', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'address', 'phone', 'fax', 'product_manufactured', 'products'],
  canary: { found: 'Aakar Foundry Pvt. Ltd.', not_found: 'अनजान ऑटो कंपोनेंट्स प्राइवेट लिमिटेड' } };

const SITE = 'https://www.acma.in';
const HOME_URL = `${SITE}/`;
const SEARCH_URL = `${SITE}/member-search.php`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const LEGAL_FORMS = new Set(['pvt', 'private', 'ltd', 'limited', 'llp']);

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function netFail(e, source_url) {
  const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return fail(timedOut ? 'timeout' : 'other', source_url, String(e?.message || e));
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare company names: case, accents, punctuation and legal form do not count. */
function normalise(str) {
  return decode(str)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return fail('other', HOME_URL, 'empty company name');
    const wanted = normalise(name);
    if (!wanted) return fail('other', HOME_URL, 'company name has no words left after removing the legal form');

    // Step 1: the search only accepts exact entries of the member list, which the home page embeds in a <select>.
    let home;
    try {
      home = await fetch(HOME_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      return netFail(e, HOME_URL);
    }
    if (home.status === 403 || home.status === 429) return fail('blocked', HOME_URL, `HTTP ${home.status}`);
    if (!home.ok) return fail('http_error', HOME_URL, `HTTP ${home.status}`);
    const homeHtml = await home.text();

    const sel = homeHtml.match(/<select[^>]*name="main_companyname"[\s\S]*?<\/select>/i);
    if (!sel) return fail('layout_changed', HOME_URL, cleanText(homeHtml).slice(0, 300));
    const members = [...sel[0].matchAll(/<option\s+value="([^"]*)"/gi)]
      .map((m) => decode(m[1]).trim())
      .filter(Boolean);
    if (members.length < 50) return fail('layout_changed', HOME_URL, `only ${members.length} entries in the member list`);

    const matches = members.filter((m) => normalise(m) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: HOME_URL,
        excerpt: `No entry in the ACMA member list (${members.length} entries) matches "${name}"`,
      };
    }

    // Step 2: POST the exact list entry to the member search and read the result table.
    const records = [];
    let excerpt = '';
    for (const member of matches.slice(0, 3)) {
      let res;
      try {
        res = await fetch(SEARCH_URL, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ main_companyname: member }).toString(),
          signal: AbortSignal.timeout(25000),
        });
      } catch (e) {
        return netFail(e, SEARCH_URL);
      }
      if (res.status === 403 || res.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', SEARCH_URL, `HTTP ${res.status}`);

      const html = await res.text();
      const table = html.match(/<table[^>]*tablecss3[\s\S]*?<\/table>/i)?.[0];
      if (!table || !/<th>\s*Company\s*<\/th>/i.test(table)) {
        if (/captcha|access denied|verify you are human/i.test(html)) return fail('blocked', SEARCH_URL, cleanText(html).slice(0, 300));
        return fail('layout_changed', SEARCH_URL, cleanText(html).slice(0, 300));
      }

      for (const row of [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1])) {
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
        if (cells.length < 4) continue;
        const company = cleanText(cells[0]);
        if (normalise(company) !== wanted) continue;

        const lines = cells[1].split(/<br\s*\/?>/i).map(cleanText).filter(Boolean);
        const phone = (lines.find((l) => /^phone\s*:/i.test(l)) || '').replace(/^phone\s*:\s*/i, '');
        const fax = (lines.find((l) => /^fax\s*:/i.test(l)) || '').replace(/^fax\s*:\s*/i, '');
        const address = lines.filter((l) => !/^(phone|fax)\s*:/i.test(l)).join(', ')
          .replace(/(\s*,\s*)+/g, ', ').replace(/^,\s*|,\s*$/g, '');
        const record = {
          name: company,
          address,
          phone,
          fax,
          product_manufactured: cleanText(cells[2]),
          products: cleanText(cells[3]),
        };
        records.push(record);
        excerpt = `${record.name} | ${record.address} | ${record.phone}`;
      }
    }

    if (records.length === 0) {
      return fail('other', SEARCH_URL, `"${matches[0]}" is in the member list but the search returned no matching row`);
    }
    return { status: 'found', reason: '', records, source_url: SEARCH_URL, excerpt: excerpt.slice(0, 500) };
  } catch (err) {
    return fail('other', SEARCH_URL, String(err?.message || err));
  }
}
