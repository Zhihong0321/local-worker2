export const meta = {
  task: 'CH-fuw.ch',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'valor', 'url'],
  canary: { found: 'Nestlé N', not_found: 'Bergwelt Verwaltungs AG' },
};

const LIST_URL = 'https://www.fuw.ch/boerse/aktienfuehrer';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that do not change which company it is.
const LEGAL = new Set(['ag', 'sa', 's', 'a', 'se', 'nv', 'ltd', 'limited', 'plc', 'inc', 'gmbh', 'kgaa', 'the']);
// Share-class letters the list appends (e.g. "Nestlé N", "Roche PS", "Swatch Group I").
const SHARE_CLASS = /^(n|i|r|b|d|p|ps|pf|br|bp|ds)$/;

function decode(s) {
  return (s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'");
}

/** Compare company names: case, accents, punctuation, "&" vs "and", legal form and share class ignored. */
function normalize(name) {
  let s = decode(name).toLowerCase().replace(/ß/g, 'ss').replace(/&/g, ' and ');
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  let tokens = s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  tokens = tokens.filter((t) => !LEGAL.has(t));
  while (tokens.length > 1 && SHARE_CLASS.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function parseEntries(html) {
  const out = [];
  const re = /<a href="(\/boerse\/aktien\/[^"]+?\/valor-(\d+)\/[^"]*)">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ name: decode(m[3]).trim(), valor: m[2], url: new URL(m[1], 'https://www.fuw.ch').href });
  }
  const seen = new Set();
  return out.filter((e) => (seen.has(e.valor) ? false : (seen.add(e.valor), true)));
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = normalize(keyword);
    if (!want) return couldnt('other', 'empty company name');

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    const entries = parseEntries(html);
    if (entries.length < 20 || !html.includes('Aktienführer')) {
      return couldnt('layout_changed', `page has ${entries.length} stock-guide rows`);
    }

    const hits = entries.filter((e) => normalize(e.name) === want);
    if (hits.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `Aktienführer lists ${entries.length} securities; none matches "${keyword}"`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records: hits.map((h) => ({ name: h.name, valor: h.valor, url: h.url })),
      source_url: LIST_URL,
      excerpt: `Aktienführer lists: ${hits.map((h) => `${h.name} (valor ${h.valor})`).join('; ')}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
