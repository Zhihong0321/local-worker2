export const meta = {
  task: 'CH-arif.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'canton', 'subject_to_lba', 'subject_to_cod'],
  canary: { found: 'Alpinex AG', not_found: 'Fiduciaire Inexistante Zorbalux Sàrl' },
};

// ARIF members list (French page). The name search is a FacetWP facet; the site answers a form POST to the page
// itself with action=facetwp_refresh and returns JSON whose "template" field holds the rendered result rows.
const PAGE_URL = 'https://arif.ch/membres/liste-des-membres-2/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;
const BUDGET_MS = 45000;

// Legal forms, after folding (accents removed, lower case, punctuation removed). "S.à r.l." folds to "sarl".
const LEGAL = new Set(['sa', 'sarl', 'rl', 'ag', 'gmbh', 'sagl', 'snc', 'scs', 'llc', 'ltd', 'inc', 'plc', 'srl', 'kg', 'ohg']);

function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Normalised tokens: runs of single letters are joined, so "S.A." and "SA" give the same token. */
function tokens(name) {
  const raw = fold(name).split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  let run = '';
  for (const t of raw) {
    if (t.length === 1) { run += t; continue; }
    if (run) { out.push(run); run = ''; }
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

function stripLegal(toks) {
  const t = toks.slice();
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

/** The typed name without its trailing legal form, used only for the site search (the match is checked separately). */
function searchTerm(keyword) {
  const words = keyword.trim().split(/\s+/);
  while (words.length > 1 && tokens(words[words.length - 1]).every((t) => LEGAL.has(t))) words.pop();
  return words.join(' ');
}

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** One result row per member article: name, canton, subject to LBA, subject to COD (in that column order). */
function parseRows(html) {
  const start = html.indexOf('facetwp-template');
  const area = start >= 0 ? html.slice(start) : html;
  const rows = [];
  for (const m of area.matchAll(/<article\b[^>]*\bclass="[^"]*\bmembre\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g)) {
    const cells = [...m[1].matchAll(/elementor-widget-container">([\s\S]*?)<\/div>/g)]
      .map((c) => cleanText(c[1]))
      .filter(Boolean);
    if (cells.length >= 2) {
      rows.push({ name: cells[0], canton: cells[1], subject_to_lba: cells[2] || '', subject_to_cod: cells[3] || '' });
    }
  }
  return rows;
}

async function fetchPage(term, paged) {
  const body = new URLSearchParams();
  body.append('action', 'facetwp_refresh');
  body.append('data[facets][membrefrsearch][]', term);
  body.append('data[template]', 'wp');
  body.append('data[paged]', String(paged));
  body.append('data[soft_refresh]', '0');
  body.append('data[first_load]', '1');
  body.append('data[http_params][uri]', 'membres/liste-des-membres-2');
  body.append('data[http_params][lang]', 'fr');
  return fetch(PAGE_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'fr-CH,fr;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
}

const CHALLENGE = /captcha|cf-chl|just a moment|attention required|access denied/i;

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = (keyword || '').trim();
  const source_url = PAGE_URL;
  try {
    const kwTokens = tokens(kw);
    if (kwTokens.join('').length < 3) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url,
        excerpt: 'name too short for the ARIF search (the site needs at least 3 characters)' };
    }
    const term = searchTerm(kw);
    const kwLegal = stripLegal(kwTokens).length < kwTokens.length;
    const kwKey = kwTokens.join(' ');
    const kwCoreKey = stripLegal(kwTokens).join(' ');

    const all = [];
    let totalRows = 0;
    let totalPages = 0;
    for (let paged = 1; paged <= MAX_PAGES; paged++) {
      if (paged > 1 && Date.now() - started > BUDGET_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url, excerpt: 'stopped before the last result page' };
      }
      const res = await fetchPage(term, paged);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url, excerpt: `HTTP ${res.status}` };
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        if (CHALLENGE.test(text.slice(0, 4000))) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: 'bot or challenge page' };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
      }
      const pager = json && json.settings && json.settings.pager;
      if (!pager || typeof json.template !== 'string' || typeof pager.total_rows_unfiltered !== 'number') {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
      }
      totalRows = pager.total_rows;
      totalPages = pager.total_pages;
      if (paged === 1 && totalRows > 0) {
        const parsed = parseRows(json.template);
        if (parsed.length === 0) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url,
            excerpt: `site reports ${totalRows} result(s) but no rows could be read` };
        }
      }
      all.push(...parseRows(json.template));
      if (paged >= totalPages) break;
    }

    const matches = all.filter((r) => {
      const rt = tokens(r.name);
      if (rt.join(' ') === kwKey) return true;
      return !kwLegal && stripLegal(rt).join(' ') === kwCoreKey;
    });

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url,
        excerpt: `ARIF members list, search "${term}": ` +
          matches.map((r) => `${r.name} | ${r.canton} | subject to LBA: ${r.subject_to_lba} | subject to COD: ${r.subject_to_cod}`).join(' ; '),
      };
    }

    if (totalPages > MAX_PAGES) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url,
        excerpt: `search "${term}" has ${totalRows} results; not all could be checked, refine the name` };
    }

    const near = all.slice(0, 5).map((r) => r.name).join(' ; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: `ARIF members list, search "${term}": ${totalRows} result(s), none matches "${kw}"` +
        (near ? `; similar listed names: ${near}` : ''),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
