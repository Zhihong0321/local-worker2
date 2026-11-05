export const meta = {
  task: 'MY-soba.com.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'award', 'category', 'division', 'year'],
  canary: { found: 'Secret Recipe Holdings Sdn Bhd', not_found: 'O2O Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://soba.com.my';
const API = BASE + '/wp-json/wp/v2';
const YEAR_SLUG = /^(\d{4})-winners$/;

let cache = null; // { pages: [{ year, slug, link, content }], source }

function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8211;|&ndash;/g, '-').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
}

function text(s) {
  return decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Strip company suffixes/punctuation so "ACME SDN. BHD." == "Acme". */
function norm(s) {
  let t = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  t = decode(t).toLowerCase();
  t = t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = ' ' + t + ' ';
  const deburr = [
    ' sdn bhd ', ' sdn bhd', ' s/b ', ' bhd ', ' sdn ',
    ' berhad ', ' enterprise ', ' enterprises ', ' company ',
  ];
  for (const d of deburr) t = t.split(d).join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    return { status: r.status, body: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

/** Parse one winners page's HTML (page content or full page) into entries. */
function parseEntries(html, year) {
  const out = [];
  // Split on category headings so each entry can carry its award category.
  const parts = String(html).split(/<h2[^>]*class="[^"]*elementor-heading-title[^"]*"[^>]*>/i);
  const heads = [];
  let lastBand = '';
  for (const p of parts) {
    const close = p.indexOf('</h2>');
    const head = close >= 0 ? text(p.slice(0, close)) : '';
    if (head) heads.push(head);
    if (/\bRM\s?\d|million/i.test(head)) lastBand = head;
    const h2txt = head;
    const liRe = /<li[^>]*class="[^"]*elementor-icon-list-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(p))) {
      const li = m[1];
      // malformed pages close some names with the literal "/h6>" instead of "</h6>"
      const h6 = li.match(/<h6[^>]*>([\s\S]*?)(?:<\/h6>|(?=\/h6>)|$)/i);
      if (!h6) continue;
      let name = text(h6[1].replace(/\/h6>[\s\S]*$/i, ''));
      name = name.replace(/\s*\/h6>.*$/, '').trim();
      if (!name) continue;
      const medal = li.match(/<text[^>]*class="[^"]*kicker[^"]*"[^>]*>([\s\S]*?)(?:<\/text>|(?:<text\/>)|(?=<h6))/i);
      const award = medal ? text(medal[1]).replace(/<text\/>/gi, '').trim() : '';
      out.push({ name, award, category: h2txt, division: lastBand.replace(/\s*No\.?\s*Category[\s\S]*$/i, '').trim(), year: year || '' });
    }
  }
  return { entries: out, heads };
}

/** Collect all year pages via the open WP REST API (falls back to the HTML pages). */
async function loadAll() {
  if (cache) return cache;

  let slugs = [];
  let listSource = '';
  try {
    const list = await get(API + '/pages?search=winners&per_page=100&_fields=slug,link,title');
    if (list.status !== 200) throw new Error('list http ' + list.status);
    const arr = JSON.parse(list.body);
    if (!Array.isArray(arr)) throw new Error('list not json array');
    slugs = arr.map((p) => ({ slug: p.slug, link: p.link })).filter((p) => YEAR_SLUG.test(p.slug));
    listSource = API + '/pages?search=winners';
    if (!slugs.length) throw new Error('no year pages found');
  } catch (e) {
    // known archive range as a last resort for the slug list
    slugs = [];
    for (let y = 2010; y <= 2026; y++) slugs.push({ slug: y + '-winners', link: BASE + '/' + y + '-winners/' });
    listSource = BASE + '/?s=winners';
  }

  const pages = [];
  let source = listSource;
  // Cheapest route: one call returns every year page's content.
  const q = slugs.map((s) => s.slug).join(',');
  const bulk = await get(API + '/pages?slug=' + encodeURIComponent(q) + '&per_page=100&_fields=slug,link,content');
  if (bulk.status === 200) {
    try {
      const arr = JSON.parse(bulk.body);
      if (Array.isArray(arr) && arr.length >= Math.min(12, slugs.length)) {
        for (const p of arr) {
          const m = p.slug && p.slug.match(YEAR_SLUG);
          if (!m) continue;
          pages.push({ year: m[1], slug: p.slug, link: p.link, content: (p.content && p.content.rendered) || '' });
        }
        source = API + '/pages?slug=' + q;
      }
    } catch (e) { /* fall through to HTML */ }
  }

  // Fallback: read the plain HTML pages, one request a second.
  if (!pages.length) {
    for (const s of slugs) {
      const year = (s.slug.match(YEAR_SLUG) || [])[1];
      const r = await get(s.link || BASE + '/' + s.slug + '/');
      if (r.status === 200 && /elementor-icon-list-item/i.test(r.body)) {
        pages.push({ year, slug: s.slug, link: s.link, content: r.body });
      }
      source = s.link || BASE + '/' + s.slug + '/';
      await new Promise((res) => setTimeout(res, 1100));
    }
  }

  if (!pages.length) throw new Error('no winners pages readable');

  const entries = [];
  let headCount = 0;
  for (const p of pages) {
    const { entries: es, heads } = parseEntries(p.content, p.year);
    headCount += heads.length;
    for (const e of es) entries.push(e);
  }
  cache = { pages, entries, source, headCount };
  return cache;
}

function matches(qNorm, nameNorm) {
  if (!qNorm) return false;
  const padded = ' ' + nameNorm + ' ';
  // exact phrase, or the query starts a word in the record name ("Cert Academy" vs "CERT ACADEMY SDN. BHD.")
  return padded.includes(' ' + qNorm + ' ') || padded.includes(' ' + qNorm);
}

function newestPage(data) {
  const sorted = data.pages.slice().sort((a, b) => String(b.year).localeCompare(String(a.year)));
  return sorted[0];
}

export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  let data;
  try {
    data = await loadAll();
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: /abort/i.test(String(e && e.message)) ? 'timeout' : 'http_error',
      records: [],
      source_url: BASE + '/2025-winners/',
      excerpt: '',
    };
  }

  // The winner archive must look like a winner archive, or we must not answer "not_found".
  const looksRight =
    data.pages.length >= 10 &&
    data.entries.length > 400 &&
    data.entries.some((e) => /platinum|gold|silver|achievement|mention/i.test(e.award));
  if (!looksRight) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: data.source,
      excerpt: ('pages=' + data.pages.length + ' entries=' + data.entries.length).slice(0, 500),
    };
  }

  const qNorm = norm(kw);
  if (qNorm.replace(/\s/g, '').length < 3) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: data.source,
      excerpt: 'keyword too short to look up: ' + kw.slice(0, 60),
    };
  }

  const hits = [];
  for (const e of data.entries) {
    if (/^no winner$/i.test(e.name)) continue;
    if (matches(qNorm, norm(e.name))) hits.push(e);
  }

  if (!hits.length) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: (newestPage(data) || {}).link || data.source,
      excerpt:
        'No entry in the SOBA winner archives (' + data.pages.map((p) => p.year).sort().join(', ') +
        ') matches "' + kw + '". ' + data.entries.length + ' winner entries checked.',
    };
  }

  const yearOf = hits[0].year;
  const page = data.pages.find((p) => p.year === yearOf);
  const source_url = (page && page.link) || BASE + '/' + yearOf + '-winners/';
  return {
    status: 'found',
    reason: '',
    records: hits.map((h) => ({
      name: h.name,
      award: h.award || '',
      category: h.category || '',
      division: h.division || '',
      year: h.year,
    })),
    source_url,
    excerpt: hits
      .slice(0, 6)
      .map((h) => 'SOBA ' + h.year + ' - ' + (h.category || 'winner') + ': ' + (h.award ? h.award + ' - ' : '') + h.name)
      .join(' | ')
      .slice(0, 500),
  };
}
