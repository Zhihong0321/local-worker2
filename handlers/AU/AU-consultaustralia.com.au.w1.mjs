export const meta = {
  task: 'AU-consultaustralia.com.au',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_page', 'list_page'],
  canary: { found: 'AECOM Australia Pty Ltd', not_found: 'Zorbonix Quantum Consulting Pty Ltd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.consultaustralia.com.au/home/about-us/our-members/';
// The site's member list is split over four plain pages. All four must be read before "not found" can be claimed.
const LIST_PAGES = ['members-a-d', 'members-e-j', 'members-k-p', 'members-q-z'].map((p) => BASE + p);

// Legal-form words removed from the end of a name before comparing.
const LEGAL_TAIL = new Set(['pty', 'ltd', 'limited', 'proprietary', 'inc']);

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', lt: '<', gt: '>' };

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const lower = name.toLowerCase();
      if (NAMED_ENTITIES[lower] !== undefined) return NAMED_ENTITIES[lower];
      // accented letters, e.g. &eacute; -> e (accents are dropped again by normalise)
      const accent = { eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', oacute: 'ó', uacute: 'ú', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä' };
      return accent[lower] !== undefined ? accent[lower] : m;
    });
}

/** Compare key: case, accents, punctuation, "&" vs "and", and the legal form at the end are ignored. */
function nameKey(str) {
  const words = decodeEntities(str || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length && LEGAL_TAIL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

async function getPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', url, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', url, excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    if (/captcha|cf-chl|just a moment|access denied/i.test(html)) {
      return { fail: 'blocked', url, excerpt: 'bot check or captcha page' };
    }
    return { url, html };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: timedOut ? 'timeout' : 'other', url, excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/**
 * Member entries: <a class="item mat-box" href="/home/about-us/our-members/SLUG" ...><h6>NAME</h6></a>.
 * The name is the title attribute when present, otherwise the <h6> text (some entries have no title).
 * Template placeholders point elsewhere (/home/about-us/members) and are never matched.
 */
function parseMembers(html, listUrl) {
  const out = [];
  const re = /<a\b([^>]*?)href="\/home\/about-us\/our-members\/([^"?#]+)"([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[2];
    const titleAttr = (m[1] + ' ' + m[3]).match(/\btitle="([^"]+)"/);
    const h6 = m[4].match(/<h6[^>]*>([\s\S]*?)<\/h6>/);
    const raw = titleAttr ? titleAttr[1] : (h6 ? h6[1].replace(/<[^>]+>/g, ' ') : '');
    const name = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (!name || /^member firm name$/i.test(name) || /^read more/i.test(name)) continue;
    out.push({
      name,
      member_page: BASE + slug,
      list_page: listUrl,
      key: nameKey(name),
      slug,
    });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = nameKey(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    const pages = await Promise.all(LIST_PAGES.map(getPage));
    const failed = pages.find((p) => p.fail);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.fail, records: [], source_url: failed.url, excerpt: failed.excerpt };
    }

    // Every page must look like the member list; otherwise the layout changed and absence cannot be shown.
    for (const p of pages) {
      if (!p.html.includes('our-members/')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: p.url, excerpt: p.html.slice(0, 300) };
      }
    }

    const seen = new Set();
    const all = [];
    for (const p of pages) {
      for (const entry of parseMembers(p.html, p.url)) {
        if (seen.has(entry.slug)) continue;
        seen.add(entry.slug);
        all.push(entry);
      }
    }
    if (all.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_PAGES[0], excerpt: 'no member entries found on the list pages' };
    }

    // Same words, or the same letters with the spaces removed ("Atkins Realis" = "AtkinsRéalis").
    const wantedCompact = wanted.replace(/ /g, '');
    const matches = all.filter((e) => e.key === wanted || e.key.replace(/ /g, '') === wantedCompact);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_PAGES[0],
        excerpt: `Checked ${all.length} Consult Australia member firms on ${LIST_PAGES.length} list pages; no match for "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({ name: e.name, member_page: e.member_page, list_page: e.list_page })),
      source_url: matches[0].list_page,
      excerpt: `Listed as a Consult Australia member firm: ${matches.map((e) => e.name).join('; ')}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
