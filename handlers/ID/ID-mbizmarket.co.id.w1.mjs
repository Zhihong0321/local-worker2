export const meta = { task: 'ID-mbizmarket.co.id', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'company_name', 'store_name', 'store_url'],
  canary: { found: 'CV. Sinar Dunia Baru', not_found: 'PT Perusahaan Fiktif Tidak Terdaftar' } };

const BASE = 'https://www.mbizmarket.co.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 5;
const LEGAL = new Set(['pt', 'cv', 'ud', 'tbk', 'persero', 'perum', 'fa', 'pd']);

function decode(s) {
  return String(s || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** Compare company names: case, punctuation and legal form (PT, CV, ...) ignored. */
function norm(s) {
  return decode(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL.has(t)).join('');
}

/** One store card per match: bold store name, then the company name, and the store page link before it. */
function parseCards(html) {
  const re = /<p class="font-bold text-md line-clamp-2">([\s\S]*?)<\/p><p class="text-xs text-ellipsis overflow-hidden whitespace-normal">([\s\S]*?)<\/p>/g;
  const hits = [...html.matchAll(re)];
  return hits.map((m, i) => {
    // the store page link (/p/...) sits after the name, inside the same card: take the first one before the next card
    const end = m.index + m[0].length;
    const next = i + 1 < hits.length ? hits[i + 1].index : html.length;
    const href = html.slice(end, next).match(/href="(\/p\/[^"]+)"/);
    const storeName = decode(m[1]);
    return {
      store_name: storeName,
      company_name: decode(m[2]) || storeName,
      store_url: href ? new URL(href[1], BASE).href : '',
    };
  });
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const firstUrl = `${BASE}/toko?q=${encodeURIComponent(kw)}`;
  try {
    if (!kw) return couldnt('other', firstUrl, 'empty company name');
    const wanted = norm(kw);
    if (!wanted) return couldnt('other', firstUrl, 'company name has no letters or digits');

    const matches = [];
    let total = null;
    let checked = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? firstUrl : `${firstUrl}&page=${page}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (/Just a moment|cf-chl|challenge-platform|g-recaptcha|captcha/i.test(html.slice(0, 30000))) {
        return couldnt('blocked', url, 'bot check or captcha page');
      }
      const plain = html.replace(/<!--[\s\S]*?-->/g, '');
      const countMatch = plain.match(/Menampilkan\s+(\d+)\s+Toko/);
      if (!countMatch) {
        if (page === 1 && plain.includes('Toko yang Anda Cari Tidak Tersedia')) {
          return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
            excerpt: `Mbizmarket store search for "${kw}": 0 results (Toko yang Anda Cari Tidak Tersedia)` };
        }
        return couldnt('layout_changed', url, decode(plain).slice(0, 300));
      }
      total = Number(countMatch[1]);
      if (total === 0) break;

      const cards = parseCards(html);
      if (cards.length === 0) return couldnt('layout_changed', url, `count ${total} but no store cards found`);
      checked += cards.length;
      for (const c of cards) {
        if (norm(c.company_name) === wanted) {
          matches.push({ name: c.company_name, company_name: c.company_name, store_name: c.store_name, store_url: c.store_url });
        }
      }
      if (matches.length > 0 || checked >= total) break;
      if (Date.now() - started > 40000) break;
    }

    if (matches.length > 0) {
      return { status: 'found', reason: '', records: matches, source_url: firstUrl,
        excerpt: `Mbizmarket store search for "${kw}": ${matches.length} company match(es) of ${total} results. ` +
          matches.map((r) => `${r.company_name} (store: ${r.store_name})`).join('; ') };
    }
    if (total === 0 || checked >= total) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `Mbizmarket store search for "${kw}": ${total} results, none with this company name` };
    }
    return couldnt('other', firstUrl, `${total} results, only ${checked} checked; no exact company match yet`);
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
