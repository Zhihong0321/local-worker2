export const meta = {
  task: 'AE-emiratesgbc.org',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'list'],
  canary: { found: 'Aldar Properties PJSC', not_found: 'شركة الواحة الخضراء للتجارة ذ.م.م' },
};

// Both directory pages are server-rendered lists: every company is in the HTML, one <div class="post-item"> each.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SOURCES = [
  { list: 'Corporate & Industry Partner Members', url: 'https://emiratesgbc.org/corporate-industry-partner/' },
  { list: 'EEP Members Database', url: 'https://emiratesgbc.org/eep-database/' },
];
// Legal-form words dropped on both sides before comparing, so "ACME LLC" matches "ACME (L.L.C.)".
const LEGAL_FORMS = new Set(['llc', 'fzllc', 'fzco', 'fzc', 'fze', 'fz', 'pjsc', 'psc', 'ltd', 'limited', 'co', 'company',
  'pte', 'pvt', 'pty', 'gmbh', 'inc', 'llp', 'bhd', 'sdn', 'sole', 'propristorship']);

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#038;|&amp;/gi, '&')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

/** Normalised comparison key: case, punctuation, "&" and legal form removed; letters of any script kept. */
function nameKey(raw) {
  let s = decode(raw).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');   // bracketed notes such as (L.L.C.) or (Industry Partner)
  s = s.replace(/&/g, ' and ');
  s = s.replace(/\./g, '');            // "L.L.C." -> "llc"
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s.split(' ').filter((t) => t && !LEGAL_FORMS.has(t)).join('');
}

function parseEntries(html, src) {
  const out = [];
  for (const block of html.split('<div class="post-item">').slice(1)) {
    const h = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h) continue;
    const name = decode(h[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const href = (block.match(/<a[^>]+href="([^"]+)"/i) || [])[1] || '';
    if (name) out.push({ name, profile_url: href ? new URL(href, src.url).href : src.url, list: src.list, page: src.url });
  }
  return out;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = nameKey(keyword);
    if (!wanted) return fail('other', SOURCES[0].url, 'the name has no words left after removing punctuation and legal form');

    const matches = [];
    const counts = [];
    let failure = null;

    for (const src of SOURCES) {
      let res;
      try {
        res = await fetch(src.url, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        failure = failure || fail(timeout ? 'timeout' : 'other', src.url, err?.message || err);
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        failure = failure || fail('blocked', src.url, `HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        failure = failure || fail('http_error', src.url, `HTTP ${res.status}`);
        continue;
      }

      const html = await res.text();
      const entries = parseEntries(html, src);
      if (entries.length === 0) {
        const botWall = /cf-challenge|Just a moment|captcha|Attention Required|Verify you are human/i.test(html);
        failure = failure || fail(botWall ? 'blocked' : 'layout_changed', src.url, html.slice(0, 200));
        continue;
      }
      counts.push(`${src.list}: ${entries.length}`);
      for (const e of entries) if (nameKey(e.name) === wanted) matches.push(e);
    }

    if (matches.length) {
      const seen = new Set();
      const records = [];
      for (const m of matches) {
        const id = `${m.list}|${m.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({ name: m.name, profile_url: m.profile_url, list: m.list });
      }
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matches[0].page,
        excerpt: `Listed on ${records[0].list} as "${records[0].name}"`.slice(0, 300),
      };
    }

    // A site that refused any list cannot prove the company is absent.
    if (failure) return failure;

    const latinOnly = /^[\x00-\x7FÀ-ɏ\s.,&()'’"\-–]*$/.test(String(keyword));
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SOURCES[0].url,
      excerpt: `No match in the site's directory lists (${counts.join('; ')})` +
        (latinOnly ? '' : '. The site lists names in English only, so a name written in another script cannot match'),
    };
  } catch (err) {
    return fail('other', SOURCES[0].url, err?.message || err);
  }
}
