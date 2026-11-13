export const meta = {
  task: 'AR-ar.computrabajo.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'page_url', 'evaluations_url', 'evaluations', 'industry', 'location', 'open_jobs'],
  canary: { found: 'CERVECERIA Y MALTERIA QUILMES SAICA Y G', not_found: 'Distribuidora Inexistente Ficticia SA' },
};

const BASE = 'https://ar.computrabajo.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;
// Start another page only while the whole call is still well inside the 60 s limit.
const NEXT_PAGE_DEADLINE_MS = 25000;

// Argentine legal-form words that are written at the end of a company name.
const LEGAL = new Set(['sa', 'srl', 'sas', 'sca', 'sh', 'sc', 'saic', 'saica', 'saicf', 'saicyf', 'sacif', 'sacifi',
  'sacifia', 'sacia', 'ltda', 'limitada', 'sociedad', 'anonima', 'responsabilidad', 'sucursal', 'ltd', 'inc', 'llc']);

/** Normalised name for comparing: no accents, no case, no punctuation, no trailing legal form. */
function key(s) {
  const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tok = t ? t.split(' ') : [];
  for (;;) {
    const n = tok.length;
    if (n === 0) break;
    if (LEGAL.has(tok[n - 1])) { tok.pop(); continue; }
    if (n >= 2 && tok[n - 2] === 'y' && tok[n - 1] === 'g') { tok.length = n - 2; continue; }
    break;
  }
  return tok.join(' ');
}

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

/** One object per result card on a search page. */
function parseCards(html) {
  const cards = [];
  for (const part of html.split('<article').slice(1)) {
    const chunk = part.split('</article>')[0];
    const h2 = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!h2) continue;
    const href = h2[1].replace(/&amp;/g, '&');
    const path = href.split('?')[0];
    const id = path.match(/-([0-9A-F]{8,})\/?$/i);
    const evalsUrl = chunk.match(/<a[^>]*class="[^"]*\bempr\b[^"]*"[^>]*href="([^"]+)"/i);
    const evals = chunk.match(/([\d.,]+)\s*Evaluaciones/i);
    const industry = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const loc = chunk.match(/icon local"><\/div>([\s\S]*?)<\/li>/i);
    const jobs = chunk.match(/icon gent_persona"><\/div>([\s\S]*?)<br/i);
    cards.push({
      name: clean(h2[2]),
      company_id: id ? id[1].toUpperCase() : '',
      page_url: new URL(path, BASE).href,
      evaluations_url: evalsUrl ? new URL(evalsUrl[1].split('?')[0], BASE).href : '',
      evaluations: evals ? evals[1] : '',
      industry: industry ? clean(industry[1]) : '',
      location: loc ? clean(loc[1]) : '',
      open_jobs: jobs ? clean(jobs[1]) : '',
    });
  }
  return cards;
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const term = String(keyword || '').trim();
  const base = `${BASE}/company/search?q=${encodeURIComponent(term)}`;
  const want = key(term);
  if (!want) return fail('other', base, 'empty company name');

  try {
    let total = null;
    let seen = 0;
    let lastUrl = base;
    let lastNames = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > NEXT_PAGE_DEADLINE_MS) break;
      const url = page === 1 ? base : `${base}&p=${page}`;
      lastUrl = url;

      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-AR,es;q=0.9',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      // The empty result page still has the (empty) results list, so check the empty message first.
      const isEmpty = /No se ha encontrado empresas/i.test(html);
      const cards = parseCards(html);
      if (isEmpty && cards.length === 0) {
        // The site answered normally with an empty result list.
        return { status: 'not_found', reason: '', records: [], source_url: url,
          excerpt: 'No se ha encontrado empresas con los filtros actuales' };
      }
      if (cards.length === 0) {
        if (/captcha|cf-chl|challenge-platform|Attention Required|Access denied/i.test(html)) {
          return fail('blocked', url, 'bot check or captcha page');
        }
        return fail('layout_changed', url, clean(html));
      }

      if (page === 1) {
        const h1 = html.match(/<h1>[\s\S]*?<span class='fwB'>(\d+)<\/span>/);
        total = h1 ? Number(h1[1]) : null;
      }
      seen += cards.length;
      lastNames = lastNames.concat(cards.map((c) => c.name)).slice(0, 10);

      const hits = cards.filter((c) => key(c.name) === want);
      if (hits.length) {
        const first = hits[0];
        return {
          status: 'found',
          reason: '',
          records: hits.map((c) => ({
            name: c.name,
            company_id: c.company_id,
            page_url: c.page_url,
            evaluations_url: c.evaluations_url,
            evaluations: c.evaluations,
            industry: c.industry,
            location: c.location,
            open_jobs: c.open_jobs,
          })),
          source_url: url,
          excerpt: `${first.name} | ${first.location} | ${first.industry} | ${first.evaluations} evaluaciones`,
        };
      }
      if (total === null || seen >= total) break;
    }

    if (total !== null && seen < total) {
      // Results exist that were not read; a match could still be among them, so this is not a "not found".
      return fail('other', lastUrl, `read ${seen} of ${total} search results, no name match yet`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `No name match among ${seen} results. Listed: ${lastNames.slice(0, 5).join(' ; ')}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', base, String(err?.message || err));
  }
}
