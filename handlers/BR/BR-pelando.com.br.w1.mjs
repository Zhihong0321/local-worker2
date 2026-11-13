export const meta = {
  task: 'BR-pelando.com.br',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'cnpj', 'website', 'pelando_page'],
  canary: { found: 'Magazine Luiza S/A', not_found: 'Xulambrix Comercio Fantasma Ltda' },
};

const BASE = 'https://www.pelando.com.br';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5',
};
// Legal-form words that are dropped from the END of a name before comparing.
const LEGAL_TAILS = new Set(['ltda', 'sa', 's', 'a', 'me', 'epp', 'eireli', 'ss', 'ltd', 'cia']);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Comparable form of a company name: no accents, punctuation or trailing legal form. */
function nameKey(name) {
  const toks = fold(name).split(/[^a-z0-9]+/).filter(Boolean);
  while (toks.length > 1 && LEGAL_TAILS.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

/** The search query: the name as typed, minus a trailing legal form. */
function searchQuery(name) {
  const toks = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (toks.length > 1 && LEGAL_TAILS.has(fold(toks[toks.length - 1]).replace(/[^a-z0-9]/g, ''))) toks.pop();
  return toks.join(' ');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cutValue(v) {
  return decode(v).split(/C[NP]{2}J:|Site oficial|Razão social/i)[0].replace(/\s+/g, ' ').trim();
}

/** Merchant slugs linked on a page (the search page links the merchants of its deals). */
function merchantSlugs(html) {
  const out = new Set();
  for (const m of String(html).matchAll(/href="(?:https:\/\/www\.pelando\.com\.br)?\/cupons-de-descontos\/([a-z0-9-]+)"/gi)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** Legal name, CNPJ and official site from a merchant page's "Razão social / CNPJ" block. */
function legalBlock(html) {
  const re = /Raz(?:ão|ao)\s+social:\s*(?:<[^>]*>\s*)*([^<]{0,200})/gi;
  for (const m of String(html).matchAll(re)) {
    const legal = cutValue(m[1]);
    if (legal.length < 2) continue;
    const window = html.slice(m.index, m.index + 600);
    const cnpj = (window.match(/C[NP]{2}J:\s*(?:<[^>]*>\s*)*([0-9./-]{8,25})/i) || [])[1] || '';
    const site = (window.match(/Site oficial:\s*(?:<[^>]*>\s*)*(https?:\/\/[^\s<"]+)/i) || [])[1] || '';
    return { legal, cnpj: cnpj.trim(), site: site.trim() };
  }
  return null;
}

function failureReason(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

async function checkMerchant(slug) {
  const url = `${BASE}/cupons-de-descontos/${slug}`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { slug, url, error: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { slug, url, error: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    return { slug, url, html, block: legalBlock(html) };
  } catch (err) {
    return { slug, url, error: failureReason(err), detail: String(err && err.message || err).slice(0, 200) };
  }
}

/** Shorter forms of the name, tried in turn: the full name, then its first words (a legal name is often not a deal term). */
function queryVariants(query) {
  const toks = query.split(' ');
  const out = [query];
  if (toks.length > 2) out.push(toks.slice(0, 2).join(' '));
  if (toks.length > 1 && toks[0].length >= 3) out.push(toks[0]);
  return [...new Set(out)];
}

async function searchOnce(query) {
  const url = `${BASE}/busca/${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (res.status === 403 || res.status === 429) return { url, error: 'blocked', detail: `HTTP ${res.status}` };
  if (!res.ok) return { url, error: 'http_error', detail: `HTTP ${res.status}` };
  const html = await res.text();
  // Pelando's own empty-result text: the site answered normally, nothing is listed for this term.
  const empty = /encontramos produtos/i.test(html);
  if (!empty && !/Mostrando resultados para/i.test(html)) {
    return { url, error: 'layout_changed', detail: cleanText(html).slice(0, 300) };
  }
  return { url, html, empty };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const query = searchQuery(keyword);
  if (!query) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
  }
  const firstUrl = `${BASE}/busca/${encodeURIComponent(query)}`;
  const want = nameKey(keyword);
  const memo = new Map(); // merchant page checked once, even when several search forms link it
  const checkOnce = (slug) => {
    if (!memo.has(slug)) memo.set(slug, checkMerchant(slug));
    return memo.get(slug);
  };
  try {
    for (const q of queryVariants(query)) {
      const s = await searchOnce(q);
      if (s.error) {
        return { status: 'couldnt_check', reason: s.error, records: [], source_url: s.url, excerpt: s.detail };
      }
      // Merchant pages: linked from the deals, and the site's own merchant links (present on every page).
      // Each one's legal name must equal the company name.
      const checks = await Promise.all(merchantSlugs(s.html).map(checkOnce));
      const records = [];
      for (const c of checks) {
        if (c.error) continue;
        const legalMatch = c.block && nameKey(c.block.legal) === want;
        const brandMatch = nameKey(c.slug) === want; // the merchant's own Pelando page name
        if (!legalMatch && !brandMatch) continue;
        records.push({
          name: c.block ? c.block.legal : c.slug,
          legal_name: c.block ? c.block.legal : '',
          cnpj: c.block ? c.block.cnpj : '',
          website: c.block ? c.block.site : '',
          pelando_page: c.url,
        });
      }
      if (records.length) {
        return {
          status: 'found', reason: '', records, source_url: s.url,
          excerpt: records.map(r => `${r.name}${r.cnpj ? ' (CNPJ ' + r.cnpj + ')' : ''}`).join('; ').slice(0, 500),
        };
      }
      // A merchant page that could not be read is a failed check, never a "not listed".
      const failed = checks.find(c => c.error);
      if (failed) {
        return { status: 'couldnt_check', reason: failed.error, records: [], source_url: failed.url,
                 excerpt: `merchant page ${failed.slug}: ${failed.detail}` };
      }
      if (!s.empty) {
        // Deals exist for this term, but no merchant page carries this company: not a "not listed".
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: s.url,
                 excerpt: `Pelando lists deals for "${q}" but no merchant page shows the company name "${keyword}"` };
      }
    }
    return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
             excerpt: `Pelando search "${query}" and its shorter forms: no products or stores found; site merchant pages do not carry this name` };
  } catch (err) {
    return { status: 'couldnt_check', reason: failureReason(err), records: [], source_url: firstUrl,
             excerpt: String(err && err.message || err).slice(0, 300) };
  }
}
