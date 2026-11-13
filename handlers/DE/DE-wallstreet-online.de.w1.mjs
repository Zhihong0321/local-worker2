export const meta = { task: 'DE-wallstreet-online.de', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'type', 'wkn', 'url'], canary: { found: 'Siemens Energy', not_found: 'Schmidt Holzbau Lindenweg GmbH' } };

const BASE = 'https://www.wallstreet-online.de';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Legal-form words that the site's listing names usually leave out ("Siemens Energy AG" is listed as "Siemens Energy").
const LEGAL = new Set(['ag', 'se', 'gmbh', 'kgaa', 'kg', 'co', 'ug', 'ohg', 'mbh', 'ltd', 'inc', 'plc', 'sa', 'nv', 'bv',
  'ab', 'asa', 'spa', 'srl', 'llc', 'corp', 'ev', 'gbr']);

function words(str) {
  return (str || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/** Normalised name without legal form: "Siemens Energy AG" and "Siemens Energy" give the same key. */
function key(str) {
  return words(str).filter((w) => !LEGAL.has(w)).join('');
}

/** The search text: the name without its legal form, because the listings do not carry it. */
function searchText(keyword) {
  const kept = (keyword || '').trim().split(/\s+/).filter((t) => {
    const w = words(t);
    return w.length > 0 && !(w.length === 1 && LEGAL.has(w[0]));
  });
  return kept.length ? kept.join(' ') : (keyword || '').trim();
}

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/** The "Übersicht" block of the search page: one <li> per listed instrument (name, type, WKN, link). */
function parseOverview(html) {
  const m = html.match(/<h2>\s*Übersicht\s*<\/h2>/);
  if (!m) return null;
  const from = m.index + m[0].length;
  const next = html.indexOf('<h2>', from);
  const block = html.slice(from, next < 0 ? undefined : next);
  const items = [];
  for (const part of block.split(/<li>/).slice(1)) {
    const href = part.match(/<a href="([^"]+)"/);
    const fade = part.match(/<span class="fadeBox">([\s\S]*?)<\/span>/);
    if (!href || !fade) continue;
    const type = part.match(/<span class="searchType[^"]*">([\s\S]*?)<\/span>/);
    const wkn = part.match(/<span class="wknBox">([\s\S]*?)<\/span>/);
    items.push({ name: clean(fade[1]), type: clean(type ? type[1] : ''), wkn: clean(wkn ? wkn[1] : ''),
      url: new URL(href[1], BASE).href });
  }
  return items;
}

function couldnt(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = (keyword || '').trim();
  const url = `${BASE}/suche?q=${encodeURIComponent(searchText(kw))}&searchoperator=same`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, url);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, url);

    const html = await res.text();
    if (!html.includes('searchResultPage')) {
      if (/captcha|cf-chl|access denied|zugriff verweigert/i.test(html)) return couldnt('blocked', 'bot or captcha page', url);
      return couldnt('layout_changed', html.slice(0, 300), url);
    }

    const items = parseOverview(html);
    if (html.includes('erzielte kein Ergebnis')) {
      return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: 'Ihre Suche erzielte kein Ergebnis.' };
    }
    if (!items || items.length === 0) return couldnt('layout_changed', 'no Übersicht results and no "kein Ergebnis" text', url);

    const target = key(kw);
    const matches = target ? items.filter((i) => key(i.name) === target) : [];
    if (matches.length > 0) {
      return {
        status: 'found', reason: '',
        records: matches.map((i) => ({ name: i.name, type: i.type, wkn: i.wkn, url: i.url })),
        source_url: url,
        excerpt: matches.map((i) => `${i.name} (${i.type}, WKN ${i.wkn})`).join('; ').slice(0, 500),
      };
    }
    // The site answered and lists other things, but none with this name: the company is not on the site.
    return {
      status: 'not_found', reason: '', records: [], source_url: url,
      excerpt: `${items.length} other result(s), none named "${kw}": ` +
        items.slice(0, 5).map((i) => `${i.name} (${i.type})`).join('; ').slice(0, 400),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', String(err && err.message ? err.message : err), url);
  }
}
