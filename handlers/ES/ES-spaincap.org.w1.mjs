export const meta = {
  task: 'ES-spaincap.org',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_type', 'address', 'postal_code', 'province', 'phone', 'fax', 'website', 'funds_managed', 'industry_preference', 'investment_min', 'investment_max', 'sectors', 'detail_url'],
  canary: { found: 'Abac Capital', not_found: 'Empresa Ficticia Inexistente SL' },
};

// SpainCap member directory: three public lists (managers, advisers, investors), each paginated with ?page=N.
// Every entry has a "Saber más" link to a public detail page. Lists are read and the name is matched; nothing is guessed.
const BASE = 'https://www.spaincap.org/quienes-somos/organizacion/socios';
const TYPES = ['gestor', 'asesor', 'inversor'];
const MAX_PAGES = 30;
const DEADLINE_MS = 50000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decode(s) {
  return String(s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

// Lowercase, no accents, only a-z0-9 separated by single spaces.
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Same as norm, with a trailing legal form removed (S.A., S.L., SLU, SAU, SASU, Sociedad Limitada, ...). Repeated until stable.
function core(s) {
  let n = ' ' + norm(s) + ' ';
  let prev;
  do {
    prev = n;
    n = n.replace(/ (s a|s l|s l u|s a u|s a s u|sa|sl|slu|sau|sasu|sociedad limitada|sociedad anonima|limitada|anonima|ltd|llc|inc|gmbh) $/, ' ');
  } while (n !== prev);
  return n.trim();
}

function textLines(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(decode)
    .filter(Boolean);
}

function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.7',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function errReason(e) {
  const n = String(e?.name || '');
  return n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : 'other';
}

// Each entry: the name is the last text line before its "Saber más" link.
function parseListing(html) {
  const out = [];
  const re = /<a[^>]+href="(https:\/\/www\.spaincap\.org\/quienes-somos\/organizacion\/socios\/(gestor|asesor|inversor)\/([a-z0-9-]+))"[^>]*>\s*Saber m[aá]s\s*<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const lines = textLines(html.slice(Math.max(0, m.index - 1500), m.index));
    out.push({ name: lines[lines.length - 1] || '', url: m[1], type: m[2] });
  }
  return out;
}

async function crawlType(type, want, started) {
  let members = 0;
  const firstUrl = `${BASE}/${type}`;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() - started > DEADLINE_MS) {
      return { error: 'timeout', url: firstUrl, excerpt: `${type}: stopped at page ${page} after ${DEADLINE_MS / 1000} s` };
    }
    const url = page === 1 ? firstUrl : `${firstUrl}?page=${page}`;
    let res;
    try {
      res = await get(url);
    } catch (e) {
      return { error: errReason(e), url, excerpt: String(e?.message || e).slice(0, 200) };
    }
    if (res.status === 403 || res.status === 429) {
      return { error: 'blocked', url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { error: 'http_error', url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const items = parseListing(html).filter((it) => it.type === type);
    if (items.length === 0) {
      if (page === 1) return { error: 'layout_changed', url, excerpt: 'no member entries on the first page: ' + textLines(html).slice(0, 8).join(' | ').slice(0, 200) };
      return { complete: true, members, url: firstUrl };
    }
    members += items.length;
    for (const it of items) {
      if (want && core(it.name) === want) {
        return { match: it, url, members };
      }
    }
  }
  return { error: 'other', url: firstUrl, excerpt: `${type}: more than ${MAX_PAGES} pages, list not finished` };
}

function parseDetail(html) {
  const LABELS = {
    'tipo de miembro': 'member_type', 'telefono': 'phone', 'direccion': 'address', 'codigo postal': 'postal_code',
    'provincia': 'province', 'fax': 'fax', 'pagina web': 'website', 'fondos gestionados': 'funds_managed',
    'preferencias industriales': 'industry_preference', 'inversion maxima': 'investment_max',
    'inversion minima': 'investment_min', 'sectores': 'sectors',
  };
  const STOP = new Set(['tipo entidad', 'spain', 'spaincap']);
  // Drops the "01." numbering and comment noise between fields. Values such as a postal code "8022" are kept.
  const lines = textLines(html).filter((l) => !/^\d{1,2}\.$/.test(l) && !/-->/.test(l));
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const key = LABELS[norm(lines[i])];
    if (!key || out[key] !== undefined) continue;
    const vals = [];
    for (let j = i + 1; j < lines.length && vals.length < 3; j++) {
      const k = norm(lines[j]);
      if (LABELS[k] || STOP.has(k) || lines[j].startsWith('SPAIN')) break;
      vals.push(lines[j]);
    }
    out[key] = vals.join(' ');
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const want = core(kw);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    const results = await Promise.all(TYPES.map((t) => crawlType(t, want, started)));

    const hit = results.find((r) => r.match);
    if (hit) {
      const it = hit.match;
      let detail = {};
      let detailText = '';
      let detailNote = '';
      try {
        const dr = await get(it.url);
        if (dr.ok) {
          const dhtml = await dr.text();
          detail = parseDetail(dhtml);
          const dl = textLines(dhtml);
          const start = Math.max(0, dl.findIndex((l) => /^Detalle de/i.test(l)));
          detailText = dl.slice(start).join(' | ').slice(0, 400);
        } else {
          detailNote = `detail page HTTP ${dr.status}`;
        }
      } catch (e) {
        detailNote = 'detail page: ' + String(e?.message || e).slice(0, 120);
      }
      const record = { name: it.name, member_type: it.type, ...detail, detail_url: it.url };
      return {
        status: 'found',
        reason: '',
        records: [record],
        source_url: it.url,
        excerpt: detailNote || detailText || it.name,
      };
    }

    const failed = results.find((r) => r.error);
    if (failed) {
      // A list we could not read to the end can never prove "not listed".
      return {
        status: 'couldnt_check',
        reason: failed.error,
        records: [],
        source_url: failed.url,
        excerpt: failed.excerpt || '',
      };
    }

    const total = results.reduce((a, r) => a + (r.members || 0), 0);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${BASE}/gestor`,
      excerpt: `No member named like "${kw}" in the full SpainCap lists (gestor, asesor, inversor): ${total} members read`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
