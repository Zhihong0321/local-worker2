export const meta = {
  task: 'DE-creditreform.de',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'detail_url'],
  canary: { found: 'Siemens Energy AG', not_found: 'Zqxvbnm Musterhandel GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that do not change the name when comparing (e.g. "Siemens Energy AG" = "Siemens Energy").
const LEGAL = new Set(['gmbh', 'ag', 'kg', 'co', 'ohg', 'ug', 'se', 'ev', 'e', 'v', 'mbh', 'gbr', 'kgaa', 'und', 'mit',
  'haftung', 'beschraenkter', 'beschrankter', 'ltd', 'inc', 'llc']);

/** Normalised name: lower case, umlauts spelled out, punctuation and legal-form words removed. */
function normalizeName(str) {
  const words = String(str || '').normalize('NFC').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !LEGAL.has(w));
  return words.join('');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '));
}

function couldnt(reason, excerpt, sourceUrl) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const searchUrl = `https://www.creditreform.de/suche?tx_solr%5Bq%5D=${encodeURIComponent(name)}`;
  try {
    if (!normalizeName(name)) {
      return couldnt('other', 'the name has no words besides the legal form', searchUrl);
    }

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return couldnt('blocked', `HTTP ${res.status}`, searchUrl);
    }
    if (!res.ok) {
      return couldnt('http_error', `HTTP ${res.status}`, searchUrl);
    }

    const html = await res.text();
    if (/challenge-platform|cf-chl-/i.test(html)) {
      return couldnt('blocked', 'bot check page', searchUrl);
    }

    const noHits = html.includes('keine Treffer erzielt');
    const resultsPage = html.includes('Gesucht nach');
    if (!noHits && !resultsPage) {
      return couldnt('layout_changed', html.slice(0, 300), searchUrl);
    }

    // Company entries: links to firmeneintrag.creditreform.de/<postcode>/<id>/<NAME>
    const entries = [];
    const seen = new Set();
    for (const m of html.matchAll(/<a\b[^>]*\bhref="(https?:\/\/firmeneintrag\.creditreform\.de\/\d[^"]*)"[^>]*>/gi)) {
      const href = decodeEntities(m[1]);
      if (seen.has(href)) continue;
      seen.add(href);
      const titleAttr = m[0].match(/\btitle="([^"]*)"/i);
      let title = titleAttr ? decodeEntities(titleAttr[1]) : '';
      if (!title) {
        const end = html.indexOf('</a>', m.index + m[0].length);
        title = cleanText(html.slice(m.index + m[0].length, end > 0 ? end : undefined));
      }
      if (title) entries.push({ name: title, url: href });
    }

    const kwNorm = normalizeName(name);
    const matches = entries.filter((e) => normalizeName(e.name) === kwNorm);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: noHits
          ? 'keine Treffer erzielt'
          : `${entries.length} other company entries listed, none named like "${name}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({ name: e.name, detail_url: e.url })),
      source_url: searchUrl,
      excerpt: matches.map((e) => e.name).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', String(err?.message || err), searchUrl);
  }
}
