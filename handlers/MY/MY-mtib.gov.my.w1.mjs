export const meta = {
  task: 'MY-mtib.gov.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'address', 'telephone', 'contact'],
  canary: { found: 'Sim Lee Sawmill Sdn. Bhd.', not_found: 'Kilang Papan Tiada Rekod Sdn Bhd' },
};

// One plain HTML page: "REGISTERED COMPANY" tables (Timber Suppliers / Timber Treaters) of MTIB's
// Certified Timber Suppliers and Treaters (CST) list. Scope: only the companies on this page.
const PAGE_URL = 'https://www.mtib.gov.my/perkhidmatan/teknikal/sijil-pembekal-dan-rawatan-kayu.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Compare names, not words: case, punctuation, '&' and the legal form at the end (Sdn Bhd / Berhad) are ignored.
function nameKey(str) {
  const s = (str || '').toLowerCase().replace(/&/g, ' and ').replace(/\(m\)/g, ' ').replace(/[^a-z0-9]+/g, '');
  return s.replace(/(sdnbhd|sdn|bhd|berhad)$/, '');
}

// Returns [{ name, category, address, telephone, contact }] from every "Category: ..." table in the section,
// or null when the section marker is missing.
function parseRegistered(html) {
  const start = html.indexOf('REGISTERED COMPANY');
  if (start === -1) return null;
  const section = html.slice(start);
  const tokenRe = /Category:\s*([^<]{1,80})<\/strong>|(<table[\s\S]*?<\/table>)/gi;
  const records = [];
  let category = '';
  let t;
  while ((t = tokenRe.exec(section)) !== null) {
    if (t[1] !== undefined) {
      category = cleanText(t[1]);
      continue;
    }
    if (!category) continue;
    const rows = t[2].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      if (/<th[\s>]/i.test(row)) continue;
      const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => cleanText(c));
      if (cells.length >= 2 && cells[0]) {
        records.push({
          name: cells[0],
          category,
          address: cells[1] || '',
          telephone: cells[2] || '',
          contact: cells[3] || '',
        });
      }
    }
  }
  return records;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = nameKey(String(keyword ?? ''));
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'empty company name' };
    }

    let res;
    try {
      res = await fetch(PAGE_URL, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: PAGE_URL, excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const records = parseRegistered(html);
    if (records === null) {
      if (/captcha|Just a moment|Attention Required|cf-chl-/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: 'bot check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: cleanText(html).slice(0, 300) };
    }
    if (records.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: 'REGISTERED COMPANY section has no company rows' };
    }

    const matches = records.filter((r) => nameKey(r.name) === key);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: `Not in the MTIB list of certified timber suppliers and treaters on this page (${records.length} companies listed). The MTIB timber directory PDF is not searched.`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: PAGE_URL,
      excerpt: matches.map((m) => `${m.name} | ${m.category} | ${m.address} | ${m.telephone} | ${m.contact}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
