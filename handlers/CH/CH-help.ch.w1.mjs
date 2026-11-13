export const meta = {
  task: 'CH-help.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'uid', 'place', 'description', 'url'],
  canary: { found: 'Nestlé Suisse S.A.', not_found: 'Zzqxwvk Holding GmbH Xyz' },
};

const BASE = 'https://www.help.ch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-CH,de;q=0.9,en;q=0.7',
};
const PAGE_SIZE = 10;     // the site shows 10 result blocks per page
const MAX_PAGES = 10;     // the site shows at most 100 addresses (10 pages); more hits than that is couldnt_check
const DEADLINE_MS = 40000;

// Legal-form words, removed from the end of a name before two names are compared.
const LEGAL_FORMS = new Set(['sa', 'ag', 'gmbh', 'sarl', 'sagl', 'llc', 'ltd', 'limited', 'inc', 'kg', 'ohg', 'plc',
  'bv', 'srl', 'ug', 'se', 'sas', 'corp', 'aktiengesellschaft', 'genossenschaft', 'anonyme']);

/** Normalised name: no case, accents, punctuation or trailing legal form. */
function nameKey(s) {
  const toks = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (toks.length && LEGAL_FORMS.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', szlig: 'ß' };

function clean(html) {
  const text = (html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (Object.prototype.hasOwnProperty.call(ENT, n) ? ENT[n] : m));
  return text.replace(/\s+/g, ' ').trim();
}

/** The hit count: the heading "N Treffer ..." if present, else the page title. Null when neither is there. */
function hitCount(html) {
  const h2 = html.match(/<h2[^>]*>\s*(\d[\d'’.\s]*)\s*Treffer/i);
  if (h2) return Number(h2[1].replace(/\D/g, ''));
  const title = html.match(/<title[^>]*>\s*(\d[\d'’.\s]*)\s*Treffer/i);
  if (title) return Number(title[1].replace(/\D/g, ''));
  return null;
}

/** Company entries (links to /firma/<id>/...). Trademark and advert blocks are ignored. */
function companyEntries(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+href="(\/firma\/((?:CHE-[\d.]+|\d+)\/[^"]*))"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = clean(m[3]);
    const url = new URL(m[1], BASE).href;
    if (!name || seen.has(url)) continue;
    seen.add(url);
    const after = html.slice(re.lastIndex, re.lastIndex + 1500);
    const cut = after.search(/<div class="col-lg-3|<hr|<a\s+href="\/firma\//i);
    const lines = (cut >= 0 ? after.slice(0, cut) : after).split(/<br\s*\/?>/i).map(clean).filter(Boolean);
    const uid = m[2].split('/')[0];
    out.push({ name, uid, place: lines[0] || '', description: lines[1] || '', url });
  }
  return out;
}

async function get(url) {
  const res = await fetch(url, { redirect: 'manual', headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location') || '', body };
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await search(keyword);
  // Let the keep-alive sockets close before the worker process exits (Node on Windows can abort at exit otherwise).
  await new Promise((resolve) => setTimeout(resolve, 400));
  return result;
}

async function search(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const firstUrl = `${BASE}/suche.cfm?hesQuickInput=${encodeURIComponent(name)}&hesDesc=false&sendform=Suchen`;
  try {
    const key = nameKey(name);
    if (!key) return couldnt('other', firstUrl, 'empty company name');

    const first = await get(firstUrl);
    if (first.status === 403 || first.status === 429) return couldnt('blocked', firstUrl, `HTTP ${first.status}`);

    const count = hitCount(first.body);
    if (count === null) {
      if (/captcha|challenge|access denied/i.test(first.body)) return couldnt('blocked', firstUrl, 'bot check page');
      if (first.status >= 400) return couldnt('http_error', firstUrl, `HTTP ${first.status}`);
      if (first.status >= 300) return couldnt('layout_changed', firstUrl, `HTTP ${first.status} to ${first.location}`);
      return couldnt('layout_changed', firstUrl, first.body.slice(0, 300));
    }
    if (count === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl, excerpt: `0 Treffer for "${name}"` };
    }

    // Read every page the site shows (it shows at most MAX_PAGES x PAGE_SIZE hits). A page can hold only trademark
    // hits, so pages are not stopped early.
    const pages = Math.ceil(count / PAGE_SIZE);
    const lastPage = Math.min(MAX_PAGES, pages);
    const matches = [];
    let html = first.body;
    let scannedEntries = 0;
    let timedOut = false;
    for (let page = 1; page <= lastPage; page++) {
      if (page > 1) {
        if (Date.now() - started > DEADLINE_MS) { timedOut = true; break; }
        const pageUrl = `${BASE}/suche.cfm?seite=${page}&hesInput=${encodeURIComponent(name)}&sort=treffer&sortart=asc`;
        const r = await get(pageUrl);
        if (r.status === 403 || r.status === 429) return couldnt('blocked', pageUrl, `HTTP ${r.status}`);
        if (r.status !== 200) return couldnt('http_error', pageUrl, `HTTP ${r.status}`);
        html = r.body;
      }
      const entries = companyEntries(html);
      scannedEntries += entries.length;
      for (const e of entries) if (nameKey(e.name) === key) matches.push(e);
    }
    const complete = lastPage >= pages && !timedOut;

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${count} Treffer; ${matches.length} match(es): ${matches.map((m) => `${m.name}, ${m.place}`).join(' | ')}`.slice(0, 500),
      };
    }
    if (!complete) {
      const why = timedOut ? 'time limit reached' : `the site lists only ${lastPage * PAGE_SIZE} of ${count} hits`;
      return couldnt(timedOut ? 'timeout' : 'other', firstUrl,
        `no exact match among ${scannedEntries} company entries read; ${why}`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `${count} Treffer, none is a company named "${name}" (${scannedEntries} company entries read)`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
