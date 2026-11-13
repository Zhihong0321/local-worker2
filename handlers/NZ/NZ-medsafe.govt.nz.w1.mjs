export const meta = {
  task: 'NZ-medsafe.govt.nz',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'postal_address', 'site_addresses', 'classes'],
  canary: { found: 'Baxter Healthcare Ltd', not_found: 'Ngā Rongoā Kōrero Limited' },
};

const SOURCE_URL = 'https://www.medsafe.govt.nz/regulatory/licensed.asp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Legal-form words are dropped so "Baxter Healthcare Limited" matches "Baxter Healthcare Ltd".
const LEGAL_FORMS = new Set(['limited', 'ltd', 'company', 'co', 'incorporated', 'inc', 'llc', 'pty', 'the']);

function normalize(str) {
  const words = (str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9\u0080-￿]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w));
  return words.join('');
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&trade;/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!/Licensed Medicine Manufacturing Sites/i.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SOURCE_URL, excerpt: cleanText(html).slice(0, 300) };
    }

    // The list is one table whose header row has "Company Name".
    const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    const table = tables.find((t) => /Company Name/i.test(t));
    if (!table) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SOURCE_URL, excerpt: 'no table with Company Name' };
    }

    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const kwNorm = normalize(keyword);
    if (!kwNorm) {
      return { status: 'not_found', reason: '', records: [], source_url: SOURCE_URL, excerpt: 'empty company name' };
    }

    const records = [];
    for (const row of rows) {
      const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
      if (cells.length < 2) continue; // header row uses <th>
      const name = cleanText(cells[0]);
      if (!name || normalize(name) !== kwNorm) continue;

      const siteItems = (cells[2] || '').match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
      const classItems = (cells[3] || '').match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
      records.push({
        name,
        postal_address: cleanText(cells[1]),
        site_addresses: siteItems.map(cleanText).filter(Boolean),
        classes: (classItems.length ? classItems : [cells[3] || '']).map(cleanText).filter(Boolean),
      });
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: SOURCE_URL, excerpt: `No licensed manufacturing site lists ${keyword}` };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: SOURCE_URL,
      excerpt: `${records[0].name} | ${records[0].postal_address}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: SOURCE_URL,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
