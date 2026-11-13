export const meta = {
  task: 'BR-doe.sp.gov.br',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'title', 'date', 'section', 'publication_id', 'url', 'matched_text'],
  canary: { found: 'PETROBRAS TRANSPORTE S.A.', not_found: 'EMPRESA INEXISTENTE XQZWV LTDA' },
};

// The site's own publication search (the Next.js page calls this JSON API).
const API = 'https://do-api-web-search.doe.sp.gov.br/v2/advanced-search/publications';
const SITE = 'https://www.doe.sp.gov.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
// Legal-form tokens after normalising "S/A", "S.A.", "LTDA." etc.
const LEGAL = ['ltda', 'ltd', 'limitada', 'sa', 's', 'a', 'eireli', 'me', 'epp', 'slu'];
// Words that may follow a company name in a publication ("..., CNPJ 12.345..." / "... inscrita ...").
const LEGAL_OR_FOLLOW = [...LEGAL, 'cnpj', 'cpf', 'inscrita', 'inscrito', 'sob'];

/** One character -> one lowercase a-z/0-9 character (accents removed), anything else -> space. Keeps indexes aligned. */
function foldChars(text) {
  return Array.from(text, (c) => {
    const d = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return /^[a-z0-9]$/.test(d) ? d : ' ';
  });
}

/** Name tokens without the legal form at the end: "PETROBRAS TRANSPORTE S.A." -> ["petrobras", "transporte"]. */
function coreTokens(keyword) {
  const toks = foldChars(keyword).join('').split(' ').filter(Boolean);
  while (toks.length > 1 && LEGAL.includes(toks[toks.length - 1])) toks.pop();
  return toks;
}

/**
 * First place in the text where the company name appears as a whole name (not a longer name that starts with it).
 * Returns the name as written on the site (with its legal form) and a short window of text around it, or null.
 */
function findName(text, tokens) {
  const orig = Array.from(text);
  const S = foldChars(text).join('');
  const pattern = new RegExp('(?:^|\\s)(' + tokens.join('\\s+') + ')(?=\\s|$)', 'g');
  let m;
  while ((m = pattern.exec(S)) !== null) {
    const coreStart = m.index + m[0].length - m[1].length;
    const end = coreStart + m[1].length;
    const rest = S.slice(end);
    const nextTok = (rest.match(/^\s*(\S*)/) || [])[1] || '';
    const punctAfter = /[,.;:()\-\/]/.test(orig[end] || '');
    // A longer company name ("ACME SERVICOS LTDA" for "ACME") is not this company.
    if (nextTok && !LEGAL_OR_FOLLOW.includes(nextTok) && !/^\d/.test(nextTok) && !punctAfter) continue;
    const tail = (rest.match(/^(?:\s+(?:ltda|ltd|limitada|sa|s|a|eireli|me|epp|slu)(?=\s|$))+/) || [''])[0];
    const spanEnd = end + tail.length;
    const winStart = Math.max(0, coreStart - 120);
    const winEnd = Math.min(orig.length, spanEnd + 160);
    return {
      matched: orig.slice(coreStart, spanEnd).join('').trim(),
      window: orig.slice(winStart, winEnd).join('').replace(/\s+/g, ' ').trim(),
    };
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const tokens = coreTokens(String(keyword || ''));
  const today = new Date().toISOString().slice(0, 10);
  // One Terms entry holding all the words: the site then requires all of them. Separate entries are OR-ed (huge hit counts).
  const terms = `Terms%5B0%5D=${tokens.join('%20')}`;
  const urlFor = (page) =>
    `${API}?${terms}&SearchMode=0&FromDate=2000-01-01&ToDate=${today}&PageNumber=${page}&PageSize=${PAGE_SIZE}`;
  const searchUrl = tokens.length ? urlFor(1) : API;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 300) });

  if (!tokens.length) return fail('other', 'no usable company name in the keyword');

  try {
    const items = [];
    let totalItems = 0;
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > 20000) break; // keep the whole call under 60 s
      const res = await fetch(urlFor(page), {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
      let data;
      try {
        data = await res.json();
      } catch {
        return fail('layout_changed', 'search response is not JSON');
      }
      if (!data || !Array.isArray(data.items) || typeof data.totalPages !== 'number') {
        return fail('layout_changed', 'search response has no items list: ' + JSON.stringify(data).slice(0, 200));
      }
      totalItems = Number(data.totalItems) || 0;
      items.push(...data.items);
      if (page >= data.totalPages) {
        complete = true;
        break;
      }
    }

    const records = [];
    for (const it of items) {
      const hit = findName(`${it.title || ''} . ${it.excerpt || ''}`, tokens);
      if (!hit) continue;
      records.push({
        name: hit.matched,
        title: it.title || '',
        date: String(it.date || '').slice(0, 10),
        section: it.hierarchy || '',
        publication_id: it.id || '',
        url: it.slug ? `${SITE}/${it.slug}` : '',
        matched_text: hit.window,
      });
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: searchUrl, excerpt: records[0].matched_text.slice(0, 300) };
    }
    if (!complete) {
      // Not every search hit was read, so "not there" cannot be claimed.
      return fail('other', `${items.length} of ${totalItems} search hits read, none named the company`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 publications name "${keyword}" among ${totalItems} search hits` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
