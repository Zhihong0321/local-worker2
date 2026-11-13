export const meta = {
  task: 'TH-francothaicc.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'sector', 'country', 'website', 'new_member'],
  canary: { found: 'SAVILLS (THAILAND) LIMITED', not_found: 'บริษัท ทดสอบ ไม่มีจริง จำกัด' },
};

const BASE = 'https://www.francothaicc.com/adhesion/annuaire-en-ligne.html';
const SEARCH_PARAM = 'tx_obladyannuaire_annuairelist%5Bfilters%5D%5Bsearch%5D';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;
const DEADLINE_MS = 40000;

// Legal-form words removed on both sides before comparing (Latin and Thai).
const LEGAL_LATIN = new Set(['ltd', 'limited', 'co', 'company', 'corp', 'corporation', 'inc', 'incorporated',
  'llc', 'llp', 'plc', 'pcl', 'pte', 'bhd', 'sdn', 'gmbh', 'sa', 'sas', 'sarl', 'pvt', 'private', 'public']);

function core(text) {
  const t = String(text || '').normalize('NFKC').toLowerCase().replace(/บริษัท|จำกัด|มหาชน/g, ' ');
  // \p{M} keeps Thai vowel and tone marks inside their words.
  return t.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w && !LEGAL_LATIN.has(w));
}

const keyOf = (text) => core(text).join('');

function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRecords(html) {
  const start = html.indexOf('list list-results');
  const segment = start >= 0 ? html.slice(start) : '';
  const cards = segment.match(/<article[\s\S]*?<\/article>/g) || [];
  return cards.map((card) => {
    const name = clean((card.match(/<h2[^>]*class="title"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]);
    const paras = [...card.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    const plain = paras.filter((p) => !/<a\b/i.test(p)).map(clean).filter(Boolean);
    const linkTag = card.match(/<a\b[^>]*href="([^"]+)"/i);
    return {
      name,
      sector: plain[0] || '',
      country: plain[1] || '',
      website: linkTag ? linkTag[1] : '',
      new_member: /label-magnet|Nouveau membre/i.test(card),
      excerpt: clean(card).slice(0, 300),
    };
  }).filter((r) => r.name);
}

const couldnt = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  if (!name) return couldnt('other', BASE, 'empty company name');

  // Search with the core name (legal form removed); the site matches it as a substring, case-insensitively.
  const term = core(name).join(' ') || name;
  const wanted = keyOf(name);
  const firstUrl = `${BASE}?${SEARCH_PARAM}=${encodeURIComponent(term)}`;

  try {
    let url = firstUrl;
    let pages = 0;
    let siteSaysNone = false;
    let incomplete = false;
    const matched = [];

    while (url && pages < MAX_PAGES) {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'fr,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      pages++;

      if (/Aucun contact trouvé/.test(html)) {
        siteSaysNone = true;
        break;
      }
      if (!/\d+\s+contacts?\s+trouvés?/.test(html)) {
        if (/challenge-platform|cf-chl|Access denied|Attention Required/i.test(html)) return couldnt('blocked', url, html.slice(0, 300));
        return couldnt('layout_changed', url, html.slice(0, 300));
      }

      matched.push(...parseRecords(html).filter((r) => keyOf(r.name) === wanted));

      // Follow "next page" only when it keeps the search filter (the plain directory's next link does not).
      const nextTag = html.match(/<a\b[^>]*\brel="next"[^>]*>/i);
      const nextHref = nextTag && (nextTag[0].match(/href="([^"]+)"/i) || [])[1];
      let nextUrl = null;
      if (nextHref) {
        nextUrl = new URL(nextHref.replace(/&amp;/g, '&'), BASE).href;
        if (!/%5Bsearch%5D|\[search\]/i.test(nextUrl)) nextUrl = null;
      }
      if (!nextUrl) break;
      if (pages >= MAX_PAGES || Date.now() - started > DEADLINE_MS) {
        incomplete = true;
        break;
      }
      url = nextUrl;
    }

    if (!matched.length && incomplete) return couldnt('other', firstUrl, `search has more pages after ${pages}; company not seen yet`);

    // The name search misses some listed companies (the "Nouveau membre" entries were absent from it),
    // so when it finds nothing, the plain first page of the directory is checked as well.
    let sourceUrl = firstUrl;
    if (!matched.length) {
      const plainRes = await fetch(BASE, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'fr,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (plainRes.status === 403 || plainRes.status === 429) return couldnt('blocked', BASE, `HTTP ${plainRes.status}`);
      if (!plainRes.ok) return couldnt('http_error', BASE, `HTTP ${plainRes.status}`);
      const plainHtml = await plainRes.text();
      if (!/\d+\s+contacts?\s+trouvés?/.test(plainHtml)) return couldnt('layout_changed', BASE, plainHtml.slice(0, 300));
      const newest = parseRecords(plainHtml).filter((r) => keyOf(r.name) === wanted);
      if (newest.length) {
        matched.push(...newest);
        sourceUrl = BASE;
      }
    }

    if (matched.length) {
      return {
        status: 'found',
        reason: '',
        records: matched.map(({ excerpt, ...rest }) => rest),
        source_url: sourceUrl,
        excerpt: matched.map((r) => r.excerpt).join(' | ').slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: siteSaysNone ? 'Aucun contact trouvé pour les critères sélectionnés; plain first page has no match' : `no card matches "${term}" on ${pages} page(s)`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
