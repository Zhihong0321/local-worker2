export const meta = {
  task: 'ID-bappebti.go.id',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'website', 'license_type', 'matched_as', 'listing_line'],
  canary: { found: 'PT Bursa Berjangka Jakarta', not_found: 'Perusahaan Fiktif Tidak Terdaftar' },
};

// Bappebti "Cek Legalitas" (the search box on bappebti.go.id links here). The page posts the keyword to search.php,
// which answers with JSON: { hasil: '<html list>' }. Matches are listed as "N. NAME, REG, WEBSITE [TYPE]" lines.
const PAGE_URL = 'https://ceklegalitas.bappebti.go.id/';
const SEARCH_URL = 'https://ceklegalitas.bappebti.go.id/search.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words. The site's own tips say not to type them in the search box, so the search uses the name without them,
// and the comparison ignores them at the start and end of both names.
const LEGAL_WORDS = new Set(['pt', 'cv', 'tbk', 'persero', 'perseroan', 'terbatas', 'ud', 'sdn', 'bhd', 'ltd', 'limited', 'pte', 'inc', 'llc']);

function words(s) {
  return (s || '')
    .replace(/\bP\.\s*T\.?(?=\s|$)/gi, ' PT ')
    .replace(/\bC\.\s*V\.?(?=\s|$)/gi, ' CV ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function coreWords(tokens) {
  const t = tokens.slice();
  while (t.length && LEGAL_WORDS.has(t[0])) t.shift();
  while (t.length && LEGAL_WORDS.has(t[t.length - 1])) t.pop();
  return t;
}

/** Turn the result HTML into plain text lines (one per <br> or block end). */
function htmlToLines(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// "1. NAME, REG, WEBSITE [TYPE]" -- the registration number always has a "/" and starts with a digit.
const ITEM = /^(\d+)\.\s+(.+?),\s*(\d[^,]*?\/[^,]*?)\s*,\s*(.*)$/;

function parseItem(line) {
  const m = line.match(ITEM);
  if (!m) return null;
  const rawName = m[2].trim();
  const reg = m[3].trim();
  const tail = m[4].trim();
  const bracket = tail.match(/\[([^\]]*)\]\s*$/);
  let website = bracket ? tail.slice(0, bracket.index) : tail;
  let licence = bracket ? bracket[1].trim() : '';
  website = website.replace(/,\s*$/, '').trim();
  if (!bracket && website.includes(',')) {
    const i = website.indexOf(',');
    licence = website.slice(i + 1).trim();
    website = website.slice(0, i).trim();
  }
  return { rawName, reg, website, licence, line };
}

/** Name variants of one listing: the current name, then any former names written as "d/h <former name>". */
function nameVariants(rawName) {
  return rawName
    .split(/\s*\bd[\/\\]h\b\s*/i)
    .map((seg, i) => ({ key: coreWords(words(seg)).join(''), matched_as: i === 0 ? 'current name' : 'former name' }))
    .filter((v) => v.key !== '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const core = coreWords(words(keyword)).join(' ');
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'no company name in the input' };
    }
    const nameKey = coreWords(words(keyword)).join('');

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE_URL,
      },
      body: new URLSearchParams({ keyword: core }).toString(),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|cf-chl|just a moment/i.test(text)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: text.slice(0, 200) };
    }
    if (!text.trim()) {
      // Seen for some keywords (e.g. "Kripto"): HTTP 200 with an empty body. That is not an answer, so it is not not_found.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'empty response body (HTTP 200)' };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: text.slice(0, 300) };
    }
    if (!data || typeof data.hasil !== 'string') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: text.slice(0, 300) };
    }

    const lines = htmlToLines(data.hasil);
    const items = lines.filter((l) => /^\d+\.\s/.test(l));

    if (items.length === 0) {
      const noHit = /Tidak\s+Ditemukan/i.test(data.hasil) && /alert-danger/i.test(data.hasil);
      if (noHit) {
        return {
          status: 'not_found',
          reason: '',
          records: [],
          source_url: PAGE_URL,
          excerpt: lines.slice(0, 2).join(' ').slice(0, 300),
        };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: lines.join(' | ').slice(0, 300) };
    }

    const records = [];
    let unparsed = 0;
    for (const item of items) {
      const p = parseItem(item);
      if (!p) {
        unparsed++;
        continue;
      }
      const hit = nameVariants(p.rawName).find((v) => v.key === nameKey);
      if (hit) {
        records.push({
          name: p.rawName,
          registration_number: p.reg,
          website: p.website,
          license_type: p.licence,
          matched_as: hit.matched_as,
          listing_line: p.line,
        });
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: PAGE_URL,
        excerpt: records[0].listing_line.slice(0, 300),
      };
    }

    if (unparsed > 0) {
      // Some listed lines could not be read, so one of them may be the company: do not claim it is not there.
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: `${unparsed} result line(s) not readable: ${items.join(' | ')}`.slice(0, 300) };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `${items.length} other result(s) for "${core}", none with this name`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
