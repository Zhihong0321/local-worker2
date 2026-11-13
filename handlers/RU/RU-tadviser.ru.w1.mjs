export const meta = {
  task: 'RU-tadviser.ru',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'page_url', 'industry', 'founded', 'header'],
  canary: { found: 'Ростелеком', not_found: 'Ромашка Тестовая Компания' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.tadviser.ru';
const NS_COMPANY = 'Компания:';
const SEARCH_PATH = '/index.php/%D0%A1%D0%BB%D1%83%D0%B6%D0%B5%D0%B1%D0%BD%D0%B0%D1%8F:Search'; // Служебная:Search

// Legal forms (Russian and a few English) that are dropped before comparing names.
const LEGAL_FORMS = new Set([
  'ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ип', 'гуп', 'муп', 'фгуп', 'чоу', 'чуп', 'тоо',
  'llc', 'ltd', 'jsc', 'pjsc', 'ojsc', 'cjsc', 'inc', 'corp', 'gmbh',
]);

function decodeEntities(s) {
  return (s || '')
    .replace(/&quot;/g, '"').replace(/&#039;|&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Name for comparing: lower case, ё=е, quotes and punctuation removed, legal form words removed. */
function normalizeName(str) {
  const words = decodeEntities(str || '')
    .toLowerCase().replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(w));
  return words.join(' ');
}

/** True when one word (quotes and punctuation ignored) is a legal form such as ПАО, ООО, LLC. */
function isLegalForm(word) {
  const w = decodeEntities(word || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
  return LEGAL_FORMS.has(w);
}

/** Title without the "(...)" part, e.g. "РТК ИТ (Ростелеком ...)" -> "РТК ИТ". */
function titleWithoutParens(title) {
  return title.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

async function getText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru,en;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, ok: res.ok, text: res.ok ? await res.text() : '' };
}

/** Company page header block: industry, founding year, country / region / city / address. */
function parseCompanyPage(html) {
  const out = { industry: '', founded: '', header: '' };
  const start = html.indexOf('<div class="company_left');
  if (start < 0) return out;
  let seg = html.slice(start, start + 4000);
  const cut = seg.search(/Топ-менеджеры|Собственники|Содержание/);
  if (cut > 0) seg = seg.slice(0, cut);
  const ind = seg.match(/<a[^>]*title="([^"]+)"/);
  if (ind) out.industry = decodeEntities(ind[1]);
  const fnd = seg.match(/С\s+(\d{4})\s+год/);
  if (fnd) out.founded = fnd[1];
  out.header = cleanText(seg).replace(/\n+/g, ' | ').slice(0, 400);
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    // Drop quotes and legal-form words ("ПАО", "ООО", "LLC"...) from the typed name; keep the rest as written.
    const core = String(keyword || '')
      .replace(/[«»"'`“”„]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !isLegalForm(w))
      .join(' ')
      .trim();
    const wanted = normalizeName(core);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name left after removing the legal form' };
    }

    // Search only the Компания (company) namespace (ns136), with a larger page of results.
    const query = encodeURIComponent(core).replace(/%20/g, '+');
    searchUrl = `${BASE}${SEARCH_PATH}?search=${query}&title=${encodeURIComponent('Служебная:Search')}&fulltext=1&ns136=1&limit=100`;

    const s = await getText(searchUrl);
    if (s.status === 403 || s.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${s.status}` };
    }
    if (!s.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${s.status}` };
    }

    const html = s.text;
    const isSearchPage = html.includes('wgCanonicalSpecialPageName = "Search"');
    if (!isSearchPage) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    // Each result is <li><a href="/index.php/Компания:..." title="Компания:...">
    const hits = [];
    const itemRe = /<li><a href="([^"]+)" title="([^"]+)"/g;
    let m;
    while ((m = itemRe.exec(html)) !== null) {
      const title = decodeEntities(m[2]);
      if (!title.startsWith(NS_COMPANY)) continue;
      const name = title.slice(NS_COMPANY.length).trim();
      const exact = normalizeName(name) === wanted || normalizeName(titleWithoutParens(name)) === wanted;
      const href = decodeEntities(m[1]);
      // The same page can be listed more than once in the results: keep it once.
      if (exact && !hits.some((h) => h.href === href)) hits.push({ name, href });
    }

    if (hits.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `TAdviser company search for "${core}" returned no company page with this name`,
      };
    }

    // Read each matching company page for its header block. A failed page read keeps the record, without the details.
    const records = [];
    for (const hit of hits) {
      const pageUrl = new URL(hit.href, BASE).href;
      let details = { industry: '', founded: '', header: '' };
      let note = '';
      try {
        const p = await getText(pageUrl);
        if (p.ok && p.text.includes('company_name')) {
          details = parseCompanyPage(p.text);
        } else {
          note = p.ok ? 'company page layout not recognised' : `company page HTTP ${p.status}`;
        }
      } catch (e) {
        note = 'company page not read: ' + String(e?.message || e).slice(0, 120);
      }
      records.push({
        name: hit.name,
        page_url: pageUrl,
        industry: details.industry,
        founded: details.founded,
        header: details.header,
        ...(note ? { note } : {}),
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records[0].header || records[0].name,
    };
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl || BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
