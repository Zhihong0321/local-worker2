export const meta = {
  task: 'CH-shab.ch',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'publication_number', 'publication_date', 'rubric', 'sub_rubric', 'cantons', 'registration_office', 'title', 'publication_id'],
  canary: { found: 'Nestlé Suisse S.A.', not_found: 'Zzyxwv Geheimfirma AG' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.shab.ch';
const PAGE_SIZE = 100;
const MAX_PAGES = 4;
// Legal-form words, compared after normalisation (dots and accents removed, lower case).
const LEGAL = new Set(['sa', 'ag', 'gmbh', 'sarl', 'sagl', 'kg', 'kgaa', 'ltd', 'llc', 'inc', 'plc', 'srl', 'spa', 'sas']);
// Gazette action words that can stand in front of a company name in a publication title (de, fr, it, en).
const ACTION = new Set(['mutation', 'mutationen', 'neueintragung', 'nouvelles', 'entrees', 'nouvelle', 'entree', 'change', 'changement',
  'cambiamenti', 'cambiamento', 'nuova', 'iscrizione', 'loschung', 'loeschung', 'radiation', 'radiazione', 'einstellung',
  'suspension', 'aufruf', 'sommation', 'fusion', 'fusione', 'spaltung', 'scission', 'konkurs', 'faillite', 'fallimento',
  'vorlaufige', 'avis', 'prealable', 'erteilte', 'gesuch', 'demande', 'permis', 'eintragung']);

function tokens(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase()
    .replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function splitKeyword(keyword) {
  const t = tokens(keyword);
  let k = t.length;
  while (k > 0 && LEGAL.has(t[k - 1])) k--;
  return { name: t.slice(0, k), legal: t.slice(k) };
}

/** One comma-separated part of a publication title against the keyword.
 *  Returns { kind: 'match', text } | { kind: 'unknown_prefix', text } | null. */
function checkPart(part, name, legal) {
  const pt = tokens(part);
  const words = part.trim().split(/\s+/);
  for (let i = 0; i + name.length <= pt.length; i++) {
    if (!name.every((t, j) => pt[i + j] === t)) continue;
    const rest = pt.slice(i + name.length);
    if (!rest.every((t) => LEGAL.has(t))) continue;
    if (legal.length && rest.join(' ') !== legal.join(' ')) continue;
    const prefix = pt.slice(0, i);
    const text = words.slice(i).join(' ');
    if (prefix.length === 0 || prefix.every((w) => ACTION.has(w))) return { kind: 'match', text };
    return { kind: 'unknown_prefix', text: words.slice(0, i).join(' ') + ' ' + text };
  }
  return null;
}

const cc = (reason, source_url, excerpt) => ({
  status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300),
});

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const searchUrl = (page) => `${BASE}/api/v1/publications?keyword=${encodeURIComponent(kw)}&publicationStates=PUBLISHED&size=${PAGE_SIZE}&page=${page}`;
  const sourceUrl = searchUrl(0);
  try {
    const { name, legal } = splitKeyword(kw);
    if (!name.length) return cc('other', sourceUrl, 'keyword has no company name part');

    // 1. Anonymous session cookie from the public homepage; the search API answers 401 without it.
    const home = await fetch(`${BASE}/`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (home.status === 403 || home.status === 429) return cc('blocked', `${BASE}/`, `HTTP ${home.status}`);
    if (!home.ok) return cc('http_error', `${BASE}/`, `HTTP ${home.status}`);
    await home.text();
    const setCookies = home.headers.getSetCookie ? home.headers.getSetCookie() : [home.headers.get('set-cookie') || ''];
    const cookie = setCookies.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');

    // 2. Publication search, page by page, while there is time left.
    const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `${BASE}/`, ...(cookie ? { Cookie: cookie } : {}) };
    const found = new Map();
    const unknownPrefix = [];
    let total = 0;
    let fetched = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = searchUrl(page);
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
      if (res.status === 401 || res.status === 403 || res.status === 429) return cc('blocked', url, `HTTP ${res.status} from the search API`);
      if (!res.ok) return cc('http_error', url, `HTTP ${res.status}`);
      const body = await res.text();
      let j = null;
      try { j = JSON.parse(body); } catch { j = null; }
      if (!j || !Array.isArray(j.content) || typeof j.total !== 'number') return cc('layout_changed', url, body);
      total = j.total;
      fetched += j.content.length;

      for (const pub of j.content) {
        const meta = pub.meta || {};
        const titles = [meta.title?.de, meta.title?.fr, meta.title?.it, meta.title?.en].filter(Boolean);
        for (const title of titles) {
          for (const part of title.split(',')) {
            const r = checkPart(part, name, legal);
            if (!r) continue;
            if (r.kind === 'unknown_prefix') { unknownPrefix.push(r.text); continue; }
            if (!found.has(meta.id)) {
              found.set(meta.id, {
                name: r.text,
                publication_number: meta.publicationNumber || '',
                publication_date: (meta.publicationDate || '').slice(0, 10),
                rubric: meta.rubric || '',
                sub_rubric: meta.subRubric || '',
                cantons: (meta.cantons || []).join(', '),
                registration_office: meta.registrationOffice?.displayName || '',
                title: meta.title?.de || title,
                publication_id: meta.id || '',
              });
            }
          }
        }
      }

      if (!j.content.length || fetched >= total) break;
      if (Date.now() - started > 30000) break; // every fetch starts before 30 s, so the call stays under 60 s
    }

    if (found.size) {
      const records = [...found.values()];
      return {
        status: 'found', reason: '', records, source_url: sourceUrl,
        excerpt: `${records.length} publication(s) carry this name; e.g. ${records[0].title}`.slice(0, 300),
      };
    }
    if (unknownPrefix.length) {
      return cc('other', sourceUrl, `name appears in a title with an unrecognised prefix, not decided: ${unknownPrefix[0]}`);
    }
    if (fetched < total) {
      return cc('other', sourceUrl, `no exact match in the first ${fetched} of ${total} results; the rest were not checked`);
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: sourceUrl,
      excerpt: `${total} publication(s) returned, none carries this company name`,
    };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return cc(reason, sourceUrl, String(err?.message || err));
  }
}
