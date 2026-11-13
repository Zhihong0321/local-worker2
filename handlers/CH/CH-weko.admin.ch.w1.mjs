export const meta = { task: 'CH-weko.admin.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'decision_title', 'document_url', 'published'],
  canary: { found: 'Fresenius Kabi', not_found: 'Müller Bäckerei Zürich AG' } };

const LIST_URL = 'https://www.weko.admin.ch/de/entscheide';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words removed from the END of the typed name only (so "Swisscom AG" -> "swisscom").
const LEGAL = new Set(['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'plc', 'kg', 'co', 'bv', 'ab', 'srl', 'spa',
  'sas', 'bhd', 'sdn', 'pte', 'corp', 'limited', 'aktiengesellschaft', 'societe', 'anonyme', 'cie']);
// Plain-text normalisation used on BOTH the typed name and the page titles: case, umlauts, accents, punctuation.
function norm(s) {
  return String(s || '')
    .replace(/ä/gi, (c) => (c === 'Ä' ? 'Ae' : 'ae')).replace(/ö/gi, (c) => (c === 'Ö' ? 'Oe' : 'oe'))
    .replace(/ü/gi, (c) => (c === 'Ü' ? 'Ue' : 'ue')).replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function decodeEntities(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function coreTokens(keyword) {
  const t = norm(keyword).split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}
function containsRun(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const core = coreTokens(keyword || '');
    if (core.join('').length < 3) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
        excerpt: 'the name has too few letters to match' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (/captcha|access denied|enable javascript/i.test(html.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'bot or captcha page' };
    }

    // Each decision is one <a class="download-item" aria-label="..." href="PDF"> with an <h4 class="download-item__title">.
    const items = [];
    const re = /<a class="download-item"[^>]*?aria-label="([^"]*)"[^>]*?href="([^"]*)"[\s\S]*?<h4 class="download-item__title">([\s\S]*?)<\/h4>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const label = decodeEntities(m[1]);
      const pub = label.match(/PDF, [^,]*, ([^,]+)$/);
      items.push({ title: decodeEntities(m[3]), url: new URL(decodeEntities(m[2]), LIST_URL).href, published: pub ? pub[1].trim() : '' });
    }
    if (items.length < 20 || !html.includes('download-item')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: `found ${items.length} decision entries; expected the list of decisions` };
    }

    const records = [];
    for (const it of items) {
      if (containsRun(norm(it.title).split(' '), core)) {
        records.push({ name: it.title, decision_title: it.title, document_url: it.url, published: it.published,
          match_basis: 'the decision title contains the company name' });
      }
    }

    if (!records.length) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `no decision title on the list (${items.length} entries) contains "${core.join(' ')}"` };
    }
    return { status: 'found', reason: '', records, source_url: LIST_URL,
      excerpt: records.map((r) => r.decision_title).join(' | ').slice(0, 500) };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
