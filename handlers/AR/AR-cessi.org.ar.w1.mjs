export const meta = {
  task: 'AR-cessi.org.ar',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'category', 'website', 'phone', 'email'],
  canary: { found: 'Accenture SRL', not_found: 'Empresa Fantasma Sociedad Anónima' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://cessi.org.ar';
const LEGAL = new Set(['sa', 'srl', 'sas', 'saci', 'sacif', 'saic', 'ltda', 'sociedad', 'anonima', 'responsabilidad', 'limitada', 'inc', 'llc', 'ltd', 'sl']);
const MAX_CANDIDATES = 40;
const BATCH = 8;
const SOFT_DEADLINE_MS = 30000;

/** lowercase, accents removed */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** name without legal form and punctuation, used to compare two company names */
function normName(s) {
  return fold(s).replace(/\./g, '').split(/[^a-z0-9]+/).filter((w) => w && !LEGAL.has(w)).join('');
}

/** the part of a site title before " - Genexus" style suffixes */
function primaryName(s) {
  return String(s || '').split(/\s[-–—|]\s|\(/)[0];
}

/** search terms: the name with the legal form and punctuation removed; the site search is a plain substring match */
function searchTerms(keyword) {
  const core = String(keyword || '')
    .normalize('NFC')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w && !LEGAL.has(fold(w)))
    .join(' ');
  if (!core) return [];
  const folded = fold(core);
  return folded === core ? [core] : [core, folded];
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** a bot-check page: challenge markers and none of this site's own member markup (the site loads reCAPTCHA for its forms, so "captcha" alone is not a signal) */
function isBlockedBody(html) {
  if (/\/socio\//.test(html)) return false;
  return /cf-chl|Just a moment\.\.\.|Attention Required|cf_chl_opt|captcha-challenge|Access denied/i.test(html.slice(0, 20000));
}

/** GET one page; returns { ok: true, html, url } or a couldnt_check answer. Never throws. */
async function getPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { ok: false, reason: 'blocked', source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', source_url: url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (isBlockedBody(html)) {
      return { ok: false, reason: 'blocked', source_url: url, excerpt: 'captcha or bot check page' };
    }
    return { ok: true, html, url };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', source_url: url, excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** slugs of the member cards on a members-list page (the search results) */
function cardSlugs(html) {
  const start = html.indexOf('class="logos-list');
  if (start < 0) return [];
  const end = html.indexOf('</section>', start);
  const block = html.slice(start, end > start ? end : undefined);
  const slugs = [];
  for (const m of block.matchAll(/href="https?:\/\/cessi\.org\.ar\/socio\/([a-z0-9-]+)\/?"/gi)) {
    if (!slugs.includes(m[1])) slugs.push(m[1]);
  }
  return slugs;
}

/** value of a labelled field on a member detail page */
function field(html, label) {
  const re = new RegExp('<p class="title">\\s*' + label + '\\s*</p>([\\s\\S]*?)(?=</div>|<p class="title">|<!--)', 'i');
  const m = html.match(re);
  return m ? clean(m[1]) : '';
}

/** read one member detail page. Never throws. */
async function readMember(slug) {
  const url = `${BASE}/socio/${slug}/`;
  const page = await getPage(url);
  if (!page.ok) return { url, reason: page.reason, excerpt: page.excerpt };
  const t = page.html.match(/<title>([^<]*)<\/title>/i);
  const name = t ? clean(t[1]).replace(/\s*[-–—|]\s*Cessi\s*$/i, '').trim() : '';
  if (!name) return { url, reason: 'layout_changed', excerpt: 'member page has no title' };
  return {
    url,
    name,
    category: field(page.html, 'Categoría'),
    website: field(page.html, 'Website'),
    phone: field(page.html, 'Teléfono'),
    email: field(page.html, 'Email'),
  };
}

function sameCompany(siteName, keyword) {
  const k = normName(keyword);
  if (!k) return false;
  return normName(siteName) === k || normName(primaryName(siteName)) === k;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const kw = String(keyword || '').trim();
  try {
    const terms = searchTerms(kw);
    if (!terms.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + '/socios/', excerpt: 'no company name left after removing the legal form' };
    }
    const searchUrls = terms.map((t) => `${BASE}/socios/?title=${encodeURIComponent(t)}`);

    const pages = await Promise.all(searchUrls.map((u) => getPage(u)));
    const failed = pages.find((p) => !p.ok);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.reason, records: [], source_url: failed.source_url, excerpt: failed.excerpt };
    }
    for (const p of pages) {
      if (!p.html.includes('socio-title-search-form') && !p.html.includes('class="logos-list')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: p.url, excerpt: 'members page has no search form or list' };
      }
    }

    const slugs = [];
    for (const p of pages) {
      for (const s of cardSlugs(p.html)) if (!slugs.includes(s)) slugs.push(s);
    }
    if (slugs.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrls[0], excerpt: `0 member results for "${terms[0]}"` };
    }
    if (slugs.length > MAX_CANDIDATES) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrls[0], excerpt: `${slugs.length} member results for "${terms[0]}" is too many to check one by one` };
    }

    const members = [];
    for (let i = 0; i < slugs.length; i += BATCH) {
      if (Date.now() - t0 > SOFT_DEADLINE_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrls[0], excerpt: `stopped after ${members.length} of ${slugs.length} member pages` };
      }
      const batch = await Promise.all(slugs.slice(i, i + BATCH).map((s) => readMember(s)));
      members.push(...batch);
    }

    const matched = members.filter((m) => m.name && sameCompany(m.name, kw));
    if (matched.length) {
      return {
        status: 'found',
        reason: '',
        records: matched.map((m) => ({
          name: m.name,
          profile_url: m.url,
          category: m.category,
          website: m.website,
          phone: m.phone,
          email: m.email,
        })),
        source_url: matched[0].url,
        excerpt: clean(matched.map((m) => `${m.name} | ${m.category}`).join(' ; ')).slice(0, 500),
      };
    }

    const unread = members.filter((m) => m.reason);
    if (unread.length) {
      return {
        status: 'couldnt_check',
        reason: unread[0].reason,
        records: [],
        source_url: unread[0].url,
        excerpt: `could not read ${unread.length} of ${members.length} member pages: ${unread[0].excerpt || ''}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrls[0],
      excerpt: `${members.length} member results for "${terms.join('" / "')}", none named "${kw}": ${members.map((m) => m.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `${BASE}/socios/`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
