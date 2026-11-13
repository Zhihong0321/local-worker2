export const meta = {
  task: 'AR-mercadolibre.com.ar',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['store_name', 'store_slug', 'store_url'],
  canary: { found: 'adidas', not_found: 'Distribuidora Inexistente Zqxw SRL' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.mercadolibre.com.ar';
const LEGAL_TOKENS = new Set(['sa', 's', 'a', 'srl', 'r', 'l', 'sas', 'sau', 'saci', 'sacif', 'sca', 'scs', 'sl', 'slu',
  'ltda', 'ltd', 'inc', 'llc', 'corp', 'co', 'sdn', 'bhd', 'gmbh', 'ag', 'bv', 'pty', 'plc']);

function fold(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Words of a name without punctuation and without the trailing legal form (SA, SRL, SAS ...). */
function nameWords(str) {
  const words = fold(str).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_TOKENS.has(words[words.length - 1])) words.pop();
  return words;
}

/** Name compared as one string: case, accents, punctuation, spaces and legal form ignored. */
function compareKey(str) {
  return nameWords(str).join('');
}

/** Store address part: lowercase, accents removed, runs of other characters become one hyphen. */
function slugOf(str) {
  return fold(str).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const key = compareKey(kw);
    if (!key) return couldnt('other', BASE + '/tiendas-oficiales', 'empty company name');

    // Candidate store addresses: the name without its legal form first, then the full name as typed.
    const slugs = [...new Set([slugOf(nameWords(kw).join(' ')), slugOf(kw)])]
      .filter(Boolean)
      .slice(0, 2);

    let blockedUrl = '';
    let layoutUrl = '';
    const checked = [];

    for (const slug of slugs) {
      const url = `${BASE}/tienda/${slug}`;
      const res = await fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-AR,es;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        blockedUrl = blockedUrl || url;
        checked.push(`${slug}: HTTP ${res.status}`);
        continue;
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') || '';
        // Redirect to a login, account check or bot check: the site refuses us, it did not answer "no store".
        if (/account-verification|\/login|\/jms\/|captcha|\/gz\//i.test(loc)) {
          blockedUrl = blockedUrl || url;
          checked.push(`${slug}: redirect to ${loc.slice(0, 120)}`);
          continue;
        }
        // Redirect to the official stores index: no store at this address.
        if (/\/tiendas-oficiales\/?(#.*)?$/i.test(loc) || new URL(loc, BASE).pathname === '/') {
          checked.push(`${slug}: no store (redirect to index)`);
          continue;
        }
        layoutUrl = layoutUrl || url;
        checked.push(`${slug}: unexpected redirect ${loc.slice(0, 120)}`);
        continue;
      }

      if (res.status === 404) {
        checked.push(`${slug}: HTTP 404`);
        continue;
      }

      if (!res.ok) {
        return couldnt('http_error', url, `HTTP ${res.status}`);
      }

      const html = await res.text();
      const title = (html.match(/<title>([^<]*)<\/title>/i)?.[1] || '').trim();
      if (!/tienda oficial/i.test(title)) {
        layoutUrl = layoutUrl || url;
        checked.push(`${slug}: page title not a store page`);
        continue;
      }

      const storeName = cleanText(title.replace(/\s*\|\s*Tienda oficial\s*$/i, ''));
      const storeKey = compareKey(storeName);
      if (storeKey && storeKey === key) {
        return {
          status: 'found',
          reason: '',
          records: [{ store_name: storeName, store_slug: slug, store_url: url }],
          source_url: url,
          excerpt: `Official store "${storeName}" at ${url}`,
        };
      }
      checked.push(`${slug}: store "${storeName}" is a different name`);
    }

    if (blockedUrl) return couldnt('blocked', blockedUrl, checked.join('; '));
    if (layoutUrl) return couldnt('layout_changed', layoutUrl, checked.join('; '));
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${BASE}/tiendas-oficiales`,
      excerpt: `No official store for "${kw}". Checked: ${checked.join('; ')}`,
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, `${BASE}/tienda/`, String(err?.message || err));
  }
}
