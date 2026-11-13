export const meta = {
  task: 'DE-vci.de',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'website'],
  canary: { found: 'ADAMA Deutschland GmbH', not_found: 'Nichtgelistete Chemiewerke Beispiel GmbH' },
};

const BASE = 'https://www.vci.de/der-vci/mitglieder/chemie-unternehmen/seiten.jsp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed from the END of a name (so "ADAMA Deutschland GmbH" -> "adama deutschland").
const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'kg', 'kgaa', 'ohg', 'gbr', 'ug', 'se', 'co', 'ev', 'e', 'v',
  'inc', 'ltd', 'limited', 'llc', 'plc', 'sa', 'sas', 'bv', 'b', 'und', 'and']);

const ENTITIES = { amp: '&', nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', quot: '"', apos: "'", lt: '<', gt: '>' };

function clean(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** The list letter the site files a name under: first Latin letter (umlauts folded to the base letter), or 0-9. */
function letterFor(keyword) {
  const first = keyword
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .charAt(0)
    .toUpperCase();
  if (/[0-9]/.test(first)) return '0-9';
  if (/[A-Z]/.test(first)) return first;
  return null;
}

/** Two normalised spellings of a name, without its legal form: accents dropped, and umlauts written out (ü -> ue). */
function coreVariants(name) {
  const low = name.toLowerCase().normalize('NFC');
  const plain = low.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  const german = low.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out = new Set();
  for (const base of [plain, german]) {
    const tokens = base.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    while (tokens.length && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
    if (tokens.length) out.add(tokens.join(' '));
  }
  return out;
}

/** The company rows of one letter page. */
function parseItems(html) {
  const items = [];
  const re = /<li class="c-member-companies__list-item">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const name = clean((body.match(/<p class="c-member-companies__list-item-label">([\s\S]*?)<\/p>/) || [])[1]);
    const address = clean((body.match(/<p class="c-member-companies__list-item-address">([\s\S]*?)<\/p>/) || [])[1]);
    const website = ((body.match(/<a [^>]*href="([^"]*)"/) || [])[1] || '').trim();
    if (name) items.push({ name, address, website, raw: clean(body) });
  }
  return items;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword ?? '').trim();
  const letter = letterFor(kw);
  const pageUrl = letter ? `${BASE}?letter=${encodeURIComponent(letter)}` : BASE;
  try {
    if (!kw) return couldnt('other', BASE, 'empty keyword');
    if (!letter) {
      return couldnt('other', BASE, `cannot pick the list letter for "${kw}": the name does not start with a Latin letter or a digit`);
    }

    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', pageUrl, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', pageUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const hasList = html.includes('c-member-companies__list') && html.includes('c-member-companies__headline');
    if (!hasList) {
      if (/captcha|access denied|are you a robot/i.test(html)) return couldnt('blocked', pageUrl, 'bot or access check page');
      return couldnt('layout_changed', pageUrl, clean(html).slice(0, 300));
    }

    const headline = clean((html.match(/<h2 class="c-member-companies__headline">([\s\S]*?)<\/h2>/) || [])[1]);
    if (headline !== letter) {
      return couldnt('layout_changed', pageUrl, `list headline is "${headline}", expected "${letter}"`);
    }

    const items = parseItems(html);
    const rowMarkers = (html.match(/class="c-member-companies__list-item"/g) || []).length;
    if (rowMarkers !== items.length) {
      return couldnt('layout_changed', pageUrl, `found ${rowMarkers} list rows but could read ${items.length}`);
    }

    const want = coreVariants(kw);
    const matches = items.filter((it) => [...coreVariants(it.name)].some((v) => want.has(v)));

    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: `Letter ${letter} lists ${items.length} companies; none matches "${kw}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({ name: m.name, address: m.address, website: m.website })),
      source_url: pageUrl,
      excerpt: matches.map((m) => m.raw).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', pageUrl, String(err?.message || err).slice(0, 300));
  }
}
