export const meta = {
  task: 'ES-eleconomista.es',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'profile_url', 'page_title'],
  canary: { found: 'ACCIONA', not_found: 'Compañía Inexistente de Pruebas S.L.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};
// Plain HTML list of Spanish company profiles (Ibex 35 block + A-Z index). robots.txt does not disallow it.
const LIST_URL = 'https://www.eleconomista.es/fichas-de-empresas/';
const PROFILE_BASE = 'https://www.eleconomista.es/empresa/';
// A full list has about 750 links; fewer means the page is not the list we expect.
const MIN_LIST_LINKS = 50;

const LEGAL_TAIL = new Set(['sa', 'sl', 'slu', 'sau', 'se', 'ltd', 'plc', 'sociedad', 'anonima', 'limitada']);

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** Comparable company name: no case, accents, punctuation, or trailing legal form (S.A., S.L., S.A.U., SE, ...). */
function nameKey(s) {
  let t = cleanText(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/\bs a u\b/g, 'sau').replace(/\bs l u\b/g, 'slu')
    .replace(/\bs a\b/g, 'sa').replace(/\bs l\b/g, 'sl').replace(/\bs e\b/g, 'se');
  const tokens = t.split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_TAIL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getPage(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const body = await res.text();
  return { status: res.status, body };
}

function parseEntries(html) {
  const seen = new Map();
  const re = /<a\s[^>]*href="(?:https?:)?(?:\/\/www\.eleconomista\.es)?\/empresa\/([^"?#\/]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = decodeEntities(m[1]);
    if (seen.has(slug)) continue;
    const name = cleanText(m[2]) || slug.replace(/-/g, ' ');
    seen.set(slug, { slug, name });
  }
  return [...seen.values()];
}

function failure(err, url) {
  const name = err && err.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return out('couldnt_check', 'timeout', [], url, 'no answer within 25 s');
  }
  return out('couldnt_check', 'other', [], url, String((err && err.message) || err).slice(0, 300));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '');
  const wanted = nameKey(input);
  if (!wanted) return out('couldnt_check', 'other', [], LIST_URL, 'empty company name');

  try {
    const list = await getPage(LIST_URL);
    if (list.status === 403 || list.status === 429) {
      return out('couldnt_check', 'blocked', [], LIST_URL, `HTTP ${list.status}`);
    }
    if (list.status !== 200) {
      return out('couldnt_check', 'http_error', [], LIST_URL, `HTTP ${list.status}`);
    }

    const entries = parseEntries(list.body);
    if (entries.length < MIN_LIST_LINKS) {
      const walled = /Access Denied|captcha|datadome|challenge-platform/i.test(list.body);
      return out('couldnt_check', walled ? 'blocked' : 'layout_changed', [], LIST_URL, list.body.slice(0, 300));
    }

    const hits = entries.filter((e) => nameKey(e.name) === wanted);
    if (hits.length === 0) {
      return out('not_found', '', [], LIST_URL,
        `"${input}" is not in the Spanish company list at ${LIST_URL} (${entries.length} companies read)`);
    }

    const records = [];
    for (const h of hits) {
      const url = PROFILE_BASE + encodeURIComponent(h.slug);
      let pageTitle = '';
      try {
        const p = await getPage(url);
        if (p.status === 200) {
          pageTitle = cleanText((p.body.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
        }
      } catch (e) {
        // Profile page not read: the company is still on the list, so the match stands.
      }
      records.push({ name: h.name, slug: h.slug, profile_url: url, page_title: pageTitle });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url,
      excerpt: `Listed on El Economista company index: ${records.map((r) => r.name).join(', ')}`,
    };
  } catch (err) {
    return failure(err, LIST_URL);
  }
}
