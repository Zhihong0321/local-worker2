export const meta = { task: 'ES-citiservi.es', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'category', 'address', 'phone', 'listing_url'],
  canary: { found: 'C3 Consulting & State', not_found: 'Zxqwv Inexistente Ñoño SL' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EMPTY_MARK = 'no hemos encontrado nada';
// Spanish legal forms at the end of a name (applied after punctuation is removed, so "S.L." becomes "s l").
const LEGAL_SUFFIX = /\s(sociedad limitada|sociedad anonima|sociedad cooperativa|s l u|s l l|s l p|s a u|s l|s a|slu|sll|slp|sau|sl|sa|sccl|s coop|scoop|sc|coop|unipersonal)$/;

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare names: case, accents, punctuation, "&" vs "y" and the legal form are ignored. */
function normalise(name) {
  let s = decode(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' y ').replace(/[^a-z0-9]+/g, ' ').trim();
  let prev;
  do {
    prev = s;
    s = (' ' + s).replace(LEGAL_SUFFIX, '').trim();
  } while (s !== prev && s.length > 0);
  return s;
}

/** Result cards of the search page, up to the "other businesses" block that follows the results. */
function parseCards(html) {
  const end = html.search(/Otros negocios distintos/i);
  const body = end > 0 ? html.slice(0, end) : html;
  const parts = body.split(/<h5 class="mb-0 mb-3 r_company"/i);
  const cards = [];
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const link = block.match(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const addrP = [...block.matchAll(/<p class="mb-0">([\s\S]*?)<\/p>/gi)].map((m) => m[1]).find((p) => !/Categor/i.test(p));
    const cat = block.match(/Categor[^<]*<strong>([\s\S]*?)<\/strong>/i);
    const tel = block.match(/<a href="tel:([^"]+)"/i);
    cards.push({
      url: decode(link[1]),
      name: clean(link[2]),
      category: cat ? clean(cat[1]) : '',
      address: addrP ? clean(addrP) : '',
      phone: tel ? decode(tel[1]).trim() : '',
      text: clean(block).slice(0, 300),
    });
  }
  return cards;
}

function cc(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await search(keyword);
  // The runner calls process.exit() right after this returns; on Windows with Node 24 that aborts (libuv assertion,
  // exit 127) while the fetch socket is still closing. A short pause lets it close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}

async function search(keyword) {
  const kw = String(keyword || '').trim();
  const searchUrl = 'https://www.citiservi.es/buscar?q=' + encodeURIComponent(kw);
  try {
    if (!kw) return cc('other', 'empty company name', searchUrl);
    const res = await fetch(searchUrl, {
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'es-ES,es;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return cc('blocked', `HTTP ${res.status}`, searchUrl);
    if (!res.ok) return cc('http_error', `HTTP ${res.status}`, searchUrl);

    const html = await res.text();
    const cards = parseCards(html);
    const emptyPage = html.toLowerCase().includes(EMPTY_MARK);

    if (cards.length === 0) {
      if (emptyPage) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'Lo sentimos pero no hemos encontrado nada' };
      }
      if (/captcha|cf-chl|access denied|acceso denegado/i.test(html)) return cc('blocked', 'bot check page', searchUrl);
      return cc('layout_changed', clean(html).slice(0, 300), searchUrl);
    }

    const wanted = normalise(kw);
    const matches = cards.filter((c) => normalise(c.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${cards.length} results, none with this name; first: ${cards[0].name}`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records: matches.map((c) => ({ name: c.name, category: c.category, address: c.address, phone: c.phone, listing_url: c.url })),
      source_url: searchUrl,
      excerpt: matches[0].text,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timeout ? 'timeout' : 'other', String(err && err.message || err).slice(0, 300), searchUrl);
  }
}
