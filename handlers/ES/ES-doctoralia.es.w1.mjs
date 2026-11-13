export const meta = {
  task: 'ES-doctoralia.es',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entity_type', 'specialization', 'city', 'profile_url', 'rating', 'opinions_count'],
  canary: { found: 'Clinica Dental Beatriz Mendoza', not_found: 'Clínica Zqxvwk Inexistente' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.doctoralia.es';

// Spanish legal-form endings (SL, S.L.U., SA, SLL, SCP, SC, CB, S.Coop, sociedad limitada, ...). The site's search
// returns nothing when the legal form is typed, so it is removed before searching and before comparing names.
const LEGAL_SUFFIX = /(?:\s+|,\s*)(?:s\.?\s?l\.?\s?u\.?|s\.?\s?l\.?\s?l\.?|s\.?\s?a\.?\s?u\.?|s\.?\s?a\.?|s\.?\s?l\.?|s\.?\s?c\.?\s?p\.?|s\.?\s?c\.?|s\.?\s?coop\.?|c\.?\s?b\.?|sociedad\s+limitada|sociedad\s+an[oó]nima|limitada|an[oó]nima|ltd\.?|llc|inc\.?|corp\.?)\s*\.?\s*$/i;

function stripLegal(s) {
  let out = (s || '').trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEGAL_SUFFIX, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function normalize(s) {
  return stripLegal((s || '').normalize('NFD').replace(/\p{M}/gu, ''))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function decode(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Read one attribute from an opening tag string, e.g. attr(tag, 'data-doctor-name').
function attr(tag, name) {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decode(m[1]) : '';
}

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = typeof keyword === 'string' ? keyword : '';
  const core = stripLegal(input);
  const searchUrl = `${BASE}/buscar?q=${encodeURIComponent(core)}`;
  const fail = (reason, excerpt, url = searchUrl) =>
    ({ status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) });

  try {
    if (!normalize(input)) return fail('other', 'empty company name');

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });

    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const html = await res.text();

    if (/<title>[^<]*(just a moment|attention required|access denied|acceso denegado)/i.test(html) ||
        /challenge-platform|cf-chl-/i.test(html)) {
      return fail('blocked', 'bot check page');
    }

    let finalPath = '';
    try { finalPath = new URL(res.url || searchUrl).pathname; } catch { finalPath = ''; }
    if (finalPath && !finalPath.startsWith('/buscar')) {
      return fail('layout_changed', `redirected to ${res.url}`);
    }

    // Each search result is one <div data-id="result-item" ...> card; its attributes carry the name and profile link.
    const starts = [...html.matchAll(/<div\b[^>]*\bdata-id="result-item"[^>]*>/g)];
    const hasNotFoundMarker = /results-not-found/.test(html);

    if (starts.length === 0 && !hasNotFoundMarker) {
      return fail('layout_changed', html.slice(0, 300));
    }

    const kwNorm = normalize(input);
    const records = [];
    for (let i = 0; i < starts.length; i++) {
      const tag = starts[i][0];
      const segEnd = i + 1 < starts.length ? starts[i + 1].index : Math.min(html.length, starts[i].index + 20000);
      const seg = html.slice(starts[i].index, segEnd);

      let name = attr(tag, 'data-doctor-name');
      if (!name) {
        const n = seg.match(/itemprop="name"[^>]*>\s*([^<]+?)\s*</);
        name = n ? decode(n[1]) : '';
      }
      if (!name || normalize(name) !== kwNorm) continue;

      const cityTag = seg.match(/<[^>]*itemprop="addressLocality"[^>]*>/);
      const profile = attr(tag, 'data-doctor-url');
      records.push({
        name,
        entity_type: attr(tag, 'data-test-entity-type') === 'facility' ? 'clinic' : (attr(tag, 'data-test-entity-type') || ''),
        specialization: attr(tag, 'data-eec-specialization-name'),
        city: cityTag ? attr(cityTag[0], 'content') : '',
        profile_url: profile ? new URL(profile, BASE).href : '',
        rating: attr(tag, 'data-eec-stars-rating'),
        opinions_count: attr(tag, 'data-eec-opinions-count'),
      });
    }

    if (records.length > 0) {
      const r = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: `${r.name} | ${r.specialization} | ${r.city} | ${r.profile_url}`.slice(0, 300),
      };
    }

    // The site answered normally (a result list or its "no results" page) and no result has this name.
    if (starts.length > 0 || hasNotFoundMarker) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${starts.length} result(s) on the page, none named "${core}"`,
      };
    }
    return fail('layout_changed', 'no result list and no not-found marker');
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', 'no answer within 25 s');
    return fail('other', String(err?.message || err));
  }
}
