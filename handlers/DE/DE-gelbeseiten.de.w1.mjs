export const meta = {
  task: 'DE-gelbeseiten.de',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'sector', 'detail_url'],
  canary: { found: 'Siemens AG', not_found: 'Zqxvwk Hallodri Bluemchen GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.gelbeseiten.de';

// Legal-form words removed before comparing names (whole words only, after lowercasing and umlaut folding).
const LEGAL_FORMS = new Set([
  'gmbh', 'mbh', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'gbr', 'ug', 'haftungsbeschraenkt', 'co', 'ek', 'ev', 'eg', 'ltd', 'inc',
]);

function normalizeName(str) {
  const s = String(str || '')
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/\./g, '')          // "e.K." -> "ek", "e.V." -> "ev"
    .replace(/&/g, ' ');
  const tokens = s.split(/[^a-z0-9]+/).filter((t) => t && !LEGAL_FORMS.has(t));
  return tokens.join('');
}

function decodeEntities(str) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in named ? named[n] : m));
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}/suche/${encodeURIComponent(String(keyword || '').trim())}/bundesweit`;
  try {
    const key = normalizeName(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name after normalisation' };
    }

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const articles = html.match(/<article\b[^>]*class="mod mod-Treffer"[\s\S]*?<\/article>/g) || [];

    // Result list present: compare every card's company name with the keyword.
    if (articles.length > 0) {
      const records = [];
      const seenNames = [];
      for (const art of articles) {
        const name = cleanText(firstMatch(art, /<h2[^>]*class="mod-Treffer__name"[^>]*>([\s\S]*?)<\/h2>/i));
        if (!name) continue;
        seenNames.push(name);
        if (normalizeName(name) !== key) continue;

        const address = cleanText(firstMatch(art, /<address[^>]*>([\s\S]*?)<\/address>/i));
        const sector = cleanText(firstMatch(art, /mod-Treffer--besteBranche[^>]*>([\s\S]*?)<\/p>/i));
        const realId = firstMatch(art, /data-realid="([^"]+)"/i);
        const detailHref = firstMatch(art, /href="(https:\/\/www\.gelbeseiten\.de\/gsbiz\/[^"]+)"/i);
        const detailUrl = detailHref || (realId ? `${BASE}/gsbiz/${realId}` : '');
        // The page can show the same listing twice (e.g. a top-of-list copy): keep one record per detail page.
        if (records.some((r) => r.detail_url === detailUrl)) continue;
        records.push({ name, address, sector, detail_url: detailUrl });
      }

      if (records.length === 0) {
        return {
          status: 'not_found',
          reason: '',
          records: [],
          source_url: searchUrl,
          excerpt: `0 exact matches for "${String(keyword).trim()}" among ${articles.length} results (names: ${seenNames.slice(0, 5).join('; ')})`.slice(0, 500),
        };
      }

      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: `${first.name}, ${first.address}`.slice(0, 500),
      };
    }

    // No result cards: is it the site's explicit "no result" page?
    const notFoundMarker = /r_total"\]\s*=\s*"0"|konnte nicht gefunden werden|<span id="mod-TrefferlisteInfo">0<\/span>|\(0 Treffer\)/i.test(html);
    if (notFoundMarker) {
      const sentence = firstMatch(html, /(Der Begriff[\s\S]{0,200}?konnte nicht gefunden werden)/i);
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: (cleanText(sentence) || `HTTP ${res.status}: 0 Treffer`).slice(0, 500),
      };
    }

    if (/cf-chl|challenge-platform|captcha|Just a moment/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}: bot check page` };
    }

    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: searchUrl,
      excerpt: cleanText(html).slice(0, 300),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
