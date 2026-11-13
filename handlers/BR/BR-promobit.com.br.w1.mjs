export const meta = { task: 'BR-promobit.com.br', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'store_url', 'website', 'rating', 'reviews', 'badges', 'description', 'coupons', 'offers', 'detail_status'],
  canary: { found: 'Magazine Luiza', not_found: 'Comércio Fantasma Zzqxwv Ltda' } };

const BASE = 'https://www.promobit.com.br';
const DIRECTORY = `${BASE}/lojas/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_STORES = 100; // the directory lists ~750 stores; fewer than this means the page changed
const BADGE_PHRASES = ['Loja verificada', 'CNPJ verificado', 'Possui loja física'];

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function cleanText(html) {
  return decode((html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare names: case, accents, punctuation and a trailing Brazilian legal form (LTDA, S.A., ME, EIRELI, EPP) are ignored. */
function core(name) {
  let s = (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/\//g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const suffix = /(?:^| )(ltda|s a|sa|me|eireli|epp|ltd|ss)$/;
  let m;
  while ((m = s.match(suffix)) && s.length > m[0].length) s = s.slice(0, s.length - m[0].length).trim();
  return s.replace(/ /g, '');
}

function failure(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function reasonFor(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

async function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function isChallenge(body) {
  return /captcha|cf-chl|challenge-platform|Just a moment\.\.\./i.test(body);
}

/** Read the store page for one matched store. Never throws; a failure is reported in detail_status. */
async function readStore(name, href) {
  const url = new URL(href, BASE).href;
  const out = { name, store_url: url, website: '', rating: '', reviews: '', badges: [], description: '', coupons: '', offers: '', detail_status: 'ok' };
  try {
    const res = await get(url);
    if (!res.ok) { out.detail_status = `HTTP ${res.status}`; return out; }
    const html = await res.text();
    const t = cleanText(html);

    const r = t.match(/(\d+(?:[.,]\d+)?)\s*\/5\s+(\d+)\s+Avalia/i);
    if (r) { out.rating = r[1].replace(',', '.'); out.reviews = r[2]; }

    const after = t.indexOf('Opiniões sobre');
    if (after >= 0) {
      const before = t.slice(0, after);
      const dom = before.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*$/i);
      if (dom) out.website = dom[1];
      const desc = before.match(/Informações sobre [^]*?\s(?=[a-z0-9-]+(?:\.[a-z0-9-]+)+\s*$)/i);
      if (desc) {
        let d = desc[0].replace(/^Informações sobre\s+/i, '').replace(/\s+$/, '');
        if (d.startsWith(name + ' ')) d = d.slice(name.length + 1);
        out.description = d.slice(0, 400);
      }
      const block = t.slice(after, after + 300);
      out.badges = BADGE_PHRASES.filter((p) => block.includes(p));
    }

    const c = t.match(/Cupons \((\d+\+?)\)/); if (c) out.coupons = c[1];
    const o = t.match(/Ofertas \((\d+\+?)\)/); if (o) out.offers = o[1];
  } catch (err) {
    out.detail_status = reasonFor(err);
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = core(keyword);
    if (!key) return failure('couldnt_check', 'other', DIRECTORY, 'empty company name');

    const res = await get(DIRECTORY);
    const body = await res.text();
    if (res.status === 403 || res.status === 429) return failure('couldnt_check', 'blocked', DIRECTORY, `HTTP ${res.status}`);
    if (!res.ok) {
      if (isChallenge(body)) return failure('couldnt_check', 'blocked', DIRECTORY, `HTTP ${res.status} challenge page`);
      return failure('couldnt_check', 'http_error', DIRECTORY, `HTTP ${res.status}`);
    }

    // Store list: <a href="/cupons/loja/<slug>/">Display Name</a>; the same link can appear twice, so dedupe by href.
    const stores = new Map();
    for (const a of body.matchAll(/<a [^>]*href="(\/cupons\/loja\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const name = cleanText(a[2]);
      if (name && !stores.has(a[1])) stores.set(a[1], name);
    }
    if (stores.size < MIN_STORES) {
      if (isChallenge(body)) return failure('couldnt_check', 'blocked', DIRECTORY, 'challenge page');
      return failure('couldnt_check', 'layout_changed', DIRECTORY, `only ${stores.size} store links; first 300 chars: ${body.slice(0, 300)}`);
    }

    const matches = [...stores].filter(([, name]) => core(name) === key);
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: DIRECTORY,
        excerpt: `${stores.size} stores listed on /lojas/; none named "${keyword}"` };
    }

    const records = [];
    for (const [href, name] of matches) records.push(await readStore(name, href));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].store_url,
      excerpt: `${records[0].name}: ${records[0].rating ? records[0].rating + '/5 from ' + records[0].reviews + ' reviews' : 'no rating'}; ${records[0].badges.join(', ') || 'no badges'}`,
    };
  } catch (err) {
    return failure('couldnt_check', reasonFor(err), DIRECTORY, err && err.message ? err.message : err);
  }
}
