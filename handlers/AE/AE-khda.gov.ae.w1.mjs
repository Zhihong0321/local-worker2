export const meta = {
  task: 'AE-khda.gov.ae',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'directory', 'location', 'telephone', 'curriculum', 'grade_range', 'detail_url'],
  canary: { found: 'Al Arqm Private School', not_found: 'شركة زهرة الصحراء الوهمية للتجارة ذ.م.م' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// KHDA public directory lists. Each is one plain server-rendered page that carries every row it lists.
const SOURCES = [
  { directory: 'private schools (English)', list: 'https://web.khda.gov.ae/en/Education-Directory/Schools' },
  { directory: 'private schools (Arabic)', list: 'https://web.khda.gov.ae/ar/Education-Directory/Schools' },
  { directory: 'higher education (English)', list: 'https://web.khda.gov.ae/en/Education-Directory/Higher-Education' },
  { directory: 'training institutes (English)', list: 'https://web.khda.gov.ae/en/Education-Directory/Training' },
];

// Legal-form words that are dropped before comparing (L.L.C, LLC, FZE, Arabic ذ.م.م / ش.ذ.م.م, ...).
const LEGAL_TOKENS = new Set(['llc', 'l', 'c', 'ltd', 'fze', 'fzc', 'fzllc', 'est', 'sdn', 'bhd', 'ذ', 'م', 'ش', 'ذم', 'شذم']);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Exact-match key: lowercase, Arabic letter variants folded, punctuation and legal-form words dropped, no spaces.
function normalise(str) {
  const folded = (str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return folded.split(/\s+/).filter((t) => t && !LEGAL_TOKENS.has(t)).join('');
}

// Each row starts at <a id="lnkName" href="...">Name</a>; the fields after it are <span id="lbl...">value</span>.
function parseRows(html, src) {
  const starts = [];
  const re = /<a id="lnkName"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    starts.push({ index: m.index, href: m[1], name: cleanText(m[2]) });
  }
  const pageUrl = src.list;
  return starts.map((s, i) => {
    const end = Math.min(starts[i + 1] ? starts[i + 1].index : html.length, s.index + 3000);
    const chunk = html.slice(s.index, end);
    const field = (ids) => {
      for (const id of ids) {
        const mm = chunk.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)<\\/span>`));
        if (mm) return cleanText(mm[1]);
      }
      return '';
    };
    return {
      name: s.name,
      directory: src.directory,
      location: field(['lblArea', 'lblLocation']),
      telephone: field(['lblTelephone']),
      curriculum: field(['lblCurriculums']),
      grade_range: field(['lblgradeRange']),
      detail_url: new URL(s.href.replace(/&amp;/gi, '&'), pageUrl).href,
    };
  });
}

async function fetchList(src) {
  try {
    const res = await fetch(src.list, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { failed: true, reason: 'blocked', url: src.list, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { failed: true, reason: 'http_error', url: src.list, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const rows = parseRows(html, src);
    if (rows.length === 0) {
      const text = cleanText(html);
      if (/captcha|access denied|request rejected|incident id/i.test(text.slice(0, 2000))) {
        return { failed: true, reason: 'blocked', url: src.list, excerpt: text.slice(0, 300) };
      }
      return { failed: true, reason: 'layout_changed', url: src.list, excerpt: text.slice(0, 300) };
    }
    return { failed: false, rows, url: src.list, directory: src.directory };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { failed: true, reason: timeout ? 'timeout' : 'other', url: src.list, excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalise(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOURCES[0].list, excerpt: 'empty company name' };
    }

    const fetched = await Promise.all(SOURCES.map(fetchList));

    const records = [];
    let firstMatchUrl = '';
    const failures = [];
    for (const f of fetched) {
      if (f.failed) {
        failures.push(f);
        continue;
      }
      for (const row of f.rows) {
        if (normalise(row.name) === key) {
          if (!firstMatchUrl) firstMatchUrl = f.url;
          const { name, directory, location, telephone, curriculum, grade_range, detail_url } = row;
          records.push({ name, directory, location, telephone, curriculum, grade_range, detail_url });
        }
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstMatchUrl,
        excerpt: records.map((r) => `${r.name} (${r.directory})`).join(' | ').slice(0, 500),
      };
    }

    // No match is only "not_found" when every list was read. A refused or failed list could hide the company.
    if (failures.length > 0) {
      return {
        status: 'couldnt_check',
        reason: failures[0].reason,
        records: [],
        source_url: failures[0].url,
        excerpt: failures.map((f) => `${f.reason} ${f.url}: ${f.excerpt}`).join(' || ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SOURCES[0].list,
      excerpt: `No match in ${SOURCES.length} KHDA directory lists (${SOURCES.map((s) => s.directory).join('; ')})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SOURCES[0].list,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
