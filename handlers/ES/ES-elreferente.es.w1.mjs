export const meta = { task: 'ES-elreferente.es', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'category', 'employees', 'social_capital', 'status', 'website', 'detail_url'],
  canary: { found: 'Medipremium S.L.', not_found: 'Empresa Inexistente Zqxv S.L.' } };

// El Referente "Directorio empresas": one plain page that lists every company entry (no pagination).
const DIRECTORY_URL = 'https://elreferente.es/directorio/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' };

// Legal forms removed from the END of a name before comparing. Only unambiguous ones.
const LEGAL_SUFFIXES = [
  ['sociedad', 'limitada'], ['sociedad', 'anonima'], ['sociedad', 'unipersonal'],
  ['slu'], ['sll'], ['slne'], ['sl'], ['sau'], ['sa'], ['srl'], ['sas'], ['sarl'], ['ltd'], ['llc'], ['inc'], ['gmbh'], ['plc'], ['bv'],
];

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const cp = parseInt(h, 16); return cp <= 0x10FFFF ? String.fromCodePoint(cp) : m; })
    .replace(/&#(\d+);/g, (m, d) => { const cp = parseInt(d, 10); return cp <= 0x10FFFF ? String.fromCodePoint(cp) : m; })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare key: lowercase, no accents, no punctuation, no trailing legal form. "Medipremium S.L." -> "medipremium". */
function nameKey(name) {
  let words = decodeEntities(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (words.length > suffix.length && words.slice(-suffix.length).join(' ') === suffix.join(' ')) {
        words = words.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return words.join('');
}

function fieldText(chunk, cls) {
  const m = chunk.match(new RegExp('class="company-field ' + cls + '"[^>]*>\\s*<div>[\\s\\S]*?</div>\\s*<div>([\\s\\S]*?)</div>'));
  return m ? cleanText(m[1]) : '';
}

/** Each entry starts at its index-item="<name>" div; its card fields follow it, before the next entry. */
function parseListing(html) {
  const starts = [...html.matchAll(/<div\b[^>]*?\bindex-item="([^"]*)"[^>]*>/g)];
  return starts.map((m, i) => {
    const tag = m[0];
    const hrefMatch = tag.match(/index-item-href="([^"]*)"/);
    const chunk = html.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : html.length);
    return {
      name: decodeEntities(m[1]).replace(/\s+/g, ' ').trim(),
      href: hrefMatch ? new URL(decodeEntities(hrefMatch[1]), DIRECTORY_URL).href : '',
      category: fieldText(chunk, 'company-item-category'),
      employees: fieldText(chunk, 'company-item-employees-qtty'),
      social_capital: fieldText(chunk, 'company-item-social-capital'),
    };
  }).filter((e) => e.name);
}

function parseDetail(html) {
  const status = html.match(/<div class="company-status"[^>]*>([\s\S]*?)<\/div>/i);
  const site = html.match(/<a href="([^"]+)"[^>]*>\s*Ver [^<]*web/i);
  return {
    status: status ? cleanText(status[1]) : '',
    website: site ? decodeEntities(site[1]) : '',
  };
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function reasonFromError(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = decodeEntities(String(keyword ?? '')).replace(/\s+/g, ' ').trim();
    if (!name) return couldnt('other', DIRECTORY_URL, 'empty company name');
    const target = nameKey(name);

    let res;
    try {
      res = await fetch(DIRECTORY_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      return couldnt(reasonFromError(e), DIRECTORY_URL, String(e?.message || e));
    }
    if (res.status === 403 || res.status === 429) return couldnt('blocked', DIRECTORY_URL, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', DIRECTORY_URL, `HTTP ${res.status}`);

    const html = await res.text();
    const entries = parseListing(html);
    if (entries.length === 0) {
      const title = html.match(/<title>([^<]*)<\/title>/i);
      if (title && /captcha|just a moment|attention required|access denied/i.test(title[1])) {
        return couldnt('blocked', DIRECTORY_URL, `bot check page: ${title[1]}`);
      }
      return couldnt('layout_changed', DIRECTORY_URL, cleanText(html).slice(0, 300));
    }

    const matches = entries.filter((e) => nameKey(e.name) === target);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: DIRECTORY_URL,
        excerpt: `No entry named "${name}" among the ${entries.length} companies in the directory`,
      };
    }

    // Detail page for the first match only (status, website). The listing alone already proves the match.
    const first = matches[0];
    let detail = { status: '', website: '' };
    let detailNote = '';
    let sourceUrl = DIRECTORY_URL;
    try {
      const dres = await fetch(first.href, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (dres.ok) {
        detail = parseDetail(await dres.text());
        sourceUrl = first.href;
      } else {
        detailNote = `detail page HTTP ${dres.status}`;
      }
    } catch (e) {
      detailNote = `detail page ${reasonFromError(e)}`;
    }

    const records = matches.map((m, i) => ({
      name: m.name,
      category: m.category,
      employees: m.employees,
      social_capital: m.social_capital,
      status: i === 0 ? detail.status : '',
      website: i === 0 ? detail.website : '',
      detail_url: m.href,
    }));

    const parts = [`Directory entry "${first.name}"`];
    if (first.category) parts.push(`category ${first.category}`);
    if (detail.status) parts.push(`status ${detail.status}`);
    if (detailNote) parts.push(detailNote);

    return { status: 'found', reason: '', records, source_url: sourceUrl, excerpt: parts.join('; ').slice(0, 500) };
  } catch (err) {
    return couldnt('other', DIRECTORY_URL, String(err?.message || err));
  }
}
