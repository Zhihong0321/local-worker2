export const meta = {
  task: 'ID-gaikindo.or.id',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_type', 'brand', 'details', 'link'],
  canary: { found: 'PT BMW INDONESIA', not_found: 'PT Kebun Sayur Sejahtera Bersama' },
};

const API = 'https://www.gaikindo.or.id/wp-json/wp/v2/anggota';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 100;
const MAX_PAGES = 5;
const START_BUDGET_MS = 30000; // no new page is started after 30 s, so the whole call stays under 60 s

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };

/** Decode HTML entities (named, decimal and hex). */
function decode(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] !== undefined ? NAMED[n.toLowerCase()] : m));
}

function safeChar(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Compare names: case, punctuation and Indonesian legal forms (PT, TBK, ...) do not count. */
const LEGAL_FORMS = new Set(['pt', 'tbk', 'persero', 'cv', 'perum', 'ud']);
function normalize(str) {
  const text = decode(str).toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return text
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join(' ');
}

/** Turn the entry's HTML body into short lines; e-mail addresses are dropped (not needed for a company record). */
function htmlToLines(html) {
  const text = decode(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
  return text
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && !/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(s));
}

function memberType(classList) {
  const slug = (Array.isArray(classList) ? classList : [])
    .find((c) => typeof c === 'string' && c.startsWith('jenis_anggota-'));
  if (!slug) return '';
  const raw = slug.replace('jenis_anggota-', '');
  return { distributor: 'Distributor', manufaktur: 'Manufaktur' }[raw] || raw;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function fetchPage(page) {
  const url = `${API}?per_page=${PER_PAGE}&page=${page}&orderby=title&order=asc&_fields=id,title,link,class_list,content`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  return { url, res };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const wanted = normalize(keyword);
    if (!wanted) return couldnt('other', API, 'empty company name');

    const all = [];
    let totalPages = 1;
    let firstUrl = API;
    let total = 0;

    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
      if (page > 1 && Date.now() - started > START_BUDGET_MS) {
        return couldnt('timeout', firstUrl, 'member list not fully read within the time limit');
      }
      const { url, res } = await fetchPage(page);
      if (page === 1) firstUrl = url;

      if (res.status === 403 || res.status === 429 || res.status === 401) {
        return couldnt('blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return couldnt('http_error', url, `HTTP ${res.status}`);
      }

      const body = await res.text();
      let items;
      try {
        items = JSON.parse(body);
      } catch {
        if (/challenge|cf-chl|captcha|just a moment/i.test(body.slice(0, 5000))) {
          return couldnt('blocked', url, 'bot check page');
        }
        return couldnt('layout_changed', url, body.slice(0, 300));
      }
      if (!Array.isArray(items) || items.some((e) => !e || typeof e.title?.rendered !== 'string')) {
        return couldnt('layout_changed', url, JSON.stringify(items).slice(0, 300));
      }

      if (page === 1) {
        totalPages = Math.max(1, parseInt(res.headers.get('x-wp-totalpages') || '1', 10) || 1);
        total = parseInt(res.headers.get('x-wp-total') || '0', 10) || 0;
      }
      all.push(...items);
    }

    // The member list is small (one page), so match it locally; this avoids relying on the site's search ranking.
    const matches = all.filter((e) => normalize(e.title.rendered) === wanted);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `No GAIKINDO member named "${keyword}" among ${all.length} listed members${total ? ` (site total ${total})` : ''}`,
      };
    }

    const records = matches.map((e) => {
      const lines = htmlToLines(e.content?.rendered);
      const brandLine = lines.map((l) => l.match(/^brand\s*:\s*(.+)$/i)).find(Boolean);
      return {
        name: decode(e.title.rendered).replace(/\s+/g, ' ').trim(),
        member_type: memberType(e.class_list),
        brand: brandLine ? brandLine[1].trim() : '',
        details: lines.join(' | '),
        link: e.link || '',
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].link || firstUrl,
      excerpt: records.map((r) => `${r.name}: ${r.details}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', API, String(err?.message || err));
  }
}
