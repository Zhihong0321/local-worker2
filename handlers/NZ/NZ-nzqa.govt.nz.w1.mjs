export const meta = {
  task: 'NZ-nzqa.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'provider_id', 'education_organisation_number', 'locations', 'address', 'website', 'current_status', 'provider_category'],
  canary: { found: 'Future Skills Academy Limited', not_found: 'Te Whare Akoranga Kore Rawa Zzqx' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.nzqa.govt.nz';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-NZ,en;q=0.9' };
const MAX_DETAILS = 5;

// Legal-form words that do not change which company is meant (compared on both sides).
const LEGAL = new Set(['ltd', 'limited', 'inc', 'incorporated', 'co', 'company', 'llc', 'trust', 'charitable']);

/** Lower-case, strip punctuation (macrons kept), drop legal-form words. Returns a single comparable string. */
function nameKey(s) {
  return (s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t))
    .join(' ');
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** Visible text of an HTML fragment. <br> becomes `brSep`. */
function cleanText(html, brSep = ' ') {
  return decodeEntities((html || '').replace(/<br\s*\/?>/gi, brSep).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Value of a details-table row whose label cell is `labelPattern` (a regex source). */
function detailCell(html, labelPattern) {
  const m = html.match(new RegExp(`${labelPattern}\\s*</(?:span|td)>[\\s\\S]*?<td[^>]*>([\\s\\S]*?)</td>`, 'i'));
  return m ? m[1] : null;
}

function errResult(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

function fetchErrorReason(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** Parse one provider details page into the useful fields. */
function parseDetails(html) {
  const orgNo = detailCell(html, 'Education Organisation\\s+number');
  const address = detailCell(html, '<td[^>]*>\\s*Address\\s*');
  const website = detailCell(html, '<td[^>]*>\\s*Website\\s*');
  const status = detailCell(html, 'Current status');
  const category = detailCell(html, 'Provider Category');
  return {
    education_organisation_number: orgNo ? cleanText(orgNo) : '',
    address: address ? cleanText(address, ', ') : '',
    website: website ? cleanText(website) : '',
    current_status: status ? cleanText(status, ' | ') : '',
    // The category cell has a trailing "explanation" link; the number is the text before the first tag.
    provider_category: category ? cleanText(category.split('<')[0]) : '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const words = String(keyword || '').trim().split(/\s+/).filter((w) => w && !LEGAL.has(nameKey(w)));
    const query = words.join(' ');
    const want = nameKey(keyword);
    if (!want) return errResult('other', BASE, 'empty company name');

    const searchUrl = `${BASE}/providers/results.do?regionCode=0&typeCode=&category=&copApprovalStatus=&nameQuery=${encodeURIComponent(query)}`;
    let res;
    try {
      res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    } catch (err) {
      return errResult(fetchErrorReason(err), searchUrl, err?.message || err);
    }
    if (res.status === 403 || res.status === 429) return errResult('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return errResult('http_error', searchUrl, `HTTP ${res.status}`);

    const body = await res.text();
    if (/captcha|cf-chl|access denied|verify you are human/i.test(body)) return errResult('blocked', searchUrl, 'bot or captcha page');
    if (body.includes('There are no providers found')) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'There are no providers found using those search criteria.' };
    }

    const table = body.match(/<table[^>]*providerTable[\s\S]*?<\/table>/i)?.[0];
    if (!table) return errResult('layout_changed', searchUrl, body.slice(0, 300));

    // Each result row: Name | Location | link with providerId.
    const byId = new Map();
    for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
      if (cells.length < 3) continue;
      const rowName = cleanText(cells[0]);
      const location = cleanText(cells[1]);
      const id = cells[2].match(/providerId=(\d+)/)?.[1];
      if (!id || !rowName) continue;

      // Same company: the whole name, or a trading name after " - " or "T/A" / "trading as".
      const candidates = [rowName, ...rowName.split(/\s+-\s+|\s+t\/a\s+|\s+trading as\s+/i)];
      if (!candidates.some((c) => nameKey(c) === want)) continue;

      if (!byId.has(id)) byId.set(id, { id, name: rowName, locations: [] });
      if (location && !byId.get(id).locations.includes(location)) byId.get(id).locations.push(location);
    }

    if (byId.size === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `No provider name matches "${keyword}" on the results page.` };
    }

    const matches = [...byId.values()];
    const expanded = matches.slice(0, MAX_DETAILS);
    const details = await Promise.all(expanded.map(async (m) => {
      const url = `${BASE}/providers/details.do?providerId=${m.id}`;
      try {
        const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (!r.ok) return { url, error: `HTTP ${r.status}` };
        return { url, parsed: parseDetails(await r.text()) };
      } catch (err) {
        return { url, error: err?.message || String(err) };
      }
    }));

    const records = expanded.map((m, i) => {
      const d = details[i];
      return {
        name: m.name,
        provider_id: m.id,
        locations: m.locations,
        details_url: d.url,
        ...(d.parsed || { education_organisation_number: '', address: '', website: '', current_status: '', provider_category: '' }),
        ...(d.error ? { details_error: d.error } : {}),
      };
    });

    const note = matches.length > MAX_DETAILS ? ` (${matches.length - MAX_DETAILS} more matching providers not expanded)` : '';
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `Matched on results page: ${matches.map((m) => `${m.name} [${m.id}]`).join('; ')}${note}`.slice(0, 500),
    };
  } catch (err) {
    return errResult('other', `${BASE}/providers/results.do`, err?.message || err);
  }
}
