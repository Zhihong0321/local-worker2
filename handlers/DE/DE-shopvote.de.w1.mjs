export const meta = {
  task: 'DE-shopvote.de',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'description', 'rating', 'review_count'],
  canary: { found: 'zalando.de', not_found: 'Zyxwvut Handelsgesellschaft GmbH' },
};

const SITE = 'https://www.shopvote.de';
const SEARCH_URL = SITE + '/suche';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['gmbh', 'ag', 'ug', 'kg', 'ohg', 'gbr', 'se', 'ek', 'kgaa', 'mbh', 'co', 'ltd', 'limited', 'inc', 'llc', 'sarl', 'bv', 'sas', 'srl', 'spa', 'plc']);
const BLOCK_RE = /captcha|challenge-platform|cf-chl|Just a moment\.\.\.|Access denied/i;

/** The company core of a name or domain: no URL, no TLD, no trailing legal form. */
function core(raw) {
  let s = String(raw || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  s = s.replace(/\.(de|com|net|org|eu|at|ch|shop|online|info|biz)$/, '');
  s = s.replace(/e\.\s?k\./g, 'ek').replace(/[.,&()]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Comparison key: umlauts folded, only a-z and 0-9 left. */
function key(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

function text(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/&auml;/gi, 'ä').replace(/&ouml;/gi, 'ö').replace(/&uuml;/gi, 'ü').replace(/&szlig;/gi, 'ß')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Rows of the "Unternehmen" (company) result list: one object per listed shop. */
function parseRows(html) {
  const start = html.indexOf('<div class="search-results');
  if (start < 0) return [];
  let part = html.slice(start);
  const end = part.indexOf('<p class="text-11" style="text-align:right');
  if (end > 0) part = part.slice(0, end);
  const rows = [];
  for (const chunk of part.split('<div class="row mb30 top3">').slice(1)) {
    const link = chunk.match(/href="(https:\/\/www\.shopvote\.de\/bewertung_[^"]+\.html)"/);
    const nameM = chunk.match(/<a [^>]*class="gray"[^>]*>([^<]+)<\/a>/);
    const descM = chunk.match(/<span class="text-12">([\s\S]*?)<\/span>/);
    const ratingM = chunk.match(/(\d+(?:[.,]\d+)?)\s*\/\s*5/);
    const revM = chunk.match(/(\d+)\s*Bewertungen/);
    if (!link || !nameM) continue;
    rows.push({
      name: text(nameM[1]),
      profile_url: link[1],
      description: descM ? text(descM[1]) : '',
      rating: ratingM ? Number(ratingM[1].replace(',', '.')) : null,
      review_count: revM ? Number(revM[1]) : null,
    });
  }
  return rows;
}

function result(status, reason, excerpt, sourceUrl, records = []) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = core(keyword);
    if (!name) return result('couldnt_check', 'other', 'empty company name', SEARCH_URL);

    // The site's own "Unternehmen" tab: the same list the tab link opens.
    const pageUrl = `${SEARCH_URL}?query=${encodeURIComponent(name)}&context=url`;

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': SITE + '/',
      },
      body: new URLSearchParams({ search: name }).toString(),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return result('couldnt_check', 'blocked', `HTTP ${res.status}`, pageUrl);
    }
    if (!res.ok) {
      return result('couldnt_check', 'http_error', `HTTP ${res.status}`, pageUrl);
    }

    const html = await res.text();
    if (!html.includes('Ihre Suche nach')) {
      if (BLOCK_RE.test(html)) return result('couldnt_check', 'blocked', 'bot or captcha page', pageUrl);
      return result('couldnt_check', 'layout_changed', html.slice(0, 300), pageUrl);
    }

    // The tab reads "Unternehmen (N)"; it is not marked active when N is 0.
    const tab = html.match(/Unternehmen\s*\((\d+)\)/);
    if (!tab) return result('couldnt_check', 'layout_changed', 'no Unternehmen tab on the search page', pageUrl);
    const count = Number(tab[1]);

    const rows = parseRows(html);
    if (rows.length === 0 && count > 0) {
      return result('couldnt_check', 'layout_changed', `tab says ${count} listed, no rows could be read`, pageUrl);
    }

    const want = key(name);
    const matches = rows.filter((r) => key(core(r.name)) === want);

    if (matches.length > 0) {
      const first = matches[0];
      return result(
        'found', '',
        `Shopvote lists "${first.name}": ${first.rating ?? '?'} / 5, ${first.review_count ?? '?'} reviews`,
        pageUrl,
        matches.map(({ name: n, profile_url, description, rating, review_count }) =>
          ({ name: n, profile_url, description, rating, review_count })),
      );
    }

    if (rows.length < count) {
      return result('couldnt_check', 'other',
        `Shopvote lists ${count} results for "${name}" but only ${rows.length} could be read`, pageUrl);
    }

    const others = rows.map((r) => r.name).slice(0, 5).join(', ');
    return result('not_found', '',
      count === 0
        ? `Shopvote search "${name}": 0 results`
        : `Shopvote search "${name}": ${count} listed, none named "${name}" (${others})`,
      pageUrl);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return result('couldnt_check', timeout ? 'timeout' : 'other',
      String((err && err.message) || err).slice(0, 300), SEARCH_URL);
  }
}
