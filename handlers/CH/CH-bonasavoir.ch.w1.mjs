export const meta = {
  task: 'CH-bonasavoir.ch',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'status', 'finma_url', 'list_page'],
  canary: { found: 'Everest Union AG', not_found: 'Bäckerei Zürcher Sonnenblume GmbH' },
};

// Bon à Savoir publishes a paginated warning list "Sociétés non autorisées en Suisse" (companies not authorised in
// Switzerland). The handler reads every page of that list and matches the name locally. The list only holds
// companies that were warned about: not_found means "not on this list", not "checked and clean".

const LIST_BASE = 'https://www.bonasavoir.ch/services/alertes-conso/alerte-conso-detail/warnliste/societes-non-autorisees-en-suisse';
const LIST_NAME = 'Sociétés non autorisées en Suisse';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 40;
const DEADLINE_MS = 50000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', uuml: 'ü', szlig: 'ß',
  Agrave: 'À', Eacute: 'É', Ccedil: 'Ç',
};

function decodeEntities(s) {
  return String(s).replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

function cleanText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Legal forms are removed from the end of a name only, so "Everest Union AG" and "Everest Union" share one key.
const LEGAL_SUFFIX = / (ag|gmbh|sa|s a|sarl|s a r l|sagl|s a g l|ltd|limited|inc|llc|plc|corp|kg|bv|ltda|spa|srl|eg|e g) $/;

// Matching key: no case, accents, punctuation or legal form. ü/ue, ö/oe, ä/ae are treated alike on both sides.
function nameKey(text) {
  const s = decodeEntities(String(text))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/ue/g, 'u').replace(/oe/g, 'o').replace(/ae/g, 'a')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  let padded = ` ${s} `;
  for (;;) {
    const next = padded.replace(LEGAL_SUFFIX, ' ');
    if (next === padded) break;
    padded = next;
  }
  return padded.trim() || s;
}

const isTimeout = (e) => !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
const looksBlocked = (html) => /challenge-platform|cf-chl|g-recaptcha|h-captcha|verify you are human/i.test(html);

function listPageUrl(n) {
  return n <= 1 ? LIST_BASE : `${LIST_BASE}/page/${n}`;
}

async function getPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-CH,fr;q=0.9,de-CH;q=0.8,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return { fail: isTimeout(e) ? 'timeout' : 'other', excerpt: `request failed: ${String(e).slice(0, 200)}` };
  }
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  try {
    return { html: await res.text() };
  } catch (e) {
    return { fail: isTimeout(e) ? 'timeout' : 'other', excerpt: `body read failed: ${String(e).slice(0, 200)}` };
  }
}

// Each list entry is <article><h3>NAME</h3> ...FINMA link... status (inscris | non_inscris) <br /></article>
function parseEntries(html, pageUrl) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const re = /<article>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const block = m[1];
    const h3 = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const name = cleanText(h3[1]);
    if (!name) continue;
    const status = (block.match(/\b(non_inscris|inscris)\b/) || [])[1] || '';
    const finma = (block.match(/href="([^"]*finma[^"]*)"/i) || [])[1] || '';
    out.push({ name, status, finma_url: decodeEntities(finma), list_page: pageUrl });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const cc = (reason, excerpt, source_url = LIST_BASE) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });
  try {
    const key = nameKey(String(keyword ?? ''));
    if (!key) return cc('other', 'empty company name');

    const first = await getPage(LIST_BASE);
    if (first.fail) return cc(first.fail, first.excerpt, LIST_BASE);
    if (!/non\s+autoris/i.test(first.html)) {
      return cc(looksBlocked(first.html) ? 'blocked' : 'layout_changed',
        `page does not show "${LIST_NAME}": ${cleanText(first.html).slice(0, 200)}`, LIST_BASE);
    }

    const pageNums = [...first.html.matchAll(/societes-non-autorisees-en-suisse\/page\/(\d+)/g)].map((x) => Number(x[1]));
    const lastPage = pageNums.length ? Math.max(...pageNums) : 1;
    if (!(lastPage >= 1 && lastPage <= MAX_PAGES)) return cc('layout_changed', `unexpected page count ${lastPage}`, LIST_BASE);

    const entries = parseEntries(first.html, LIST_BASE);
    if (entries.length === 0) return cc('layout_changed', 'no entries on page 1', LIST_BASE);

    for (let n = 2; n <= lastPage; n++) {
      const url = listPageUrl(n);
      if (Date.now() - started > DEADLINE_MS) {
        return cc('timeout', `list not fully read after ${DEADLINE_MS / 1000} s (page ${n} of ${lastPage} not read)`, url);
      }
      const page = await getPage(url);
      if (page.fail) return cc(page.fail, page.excerpt, url);
      const got = parseEntries(page.html, url);
      if (got.length === 0) {
        return cc(looksBlocked(page.html) ? 'blocked' : 'layout_changed', `page ${n} has no list entries`, url);
      }
      entries.push(...got);
    }

    const seen = new Set();
    const unique = entries.filter((e) => {
      const k = `${nameKey(e.name)}|${e.finma_url}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const matches = unique.filter((e) => nameKey(e.name) === key);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_BASE,
        excerpt: `not on "${LIST_NAME}" (${unique.length} entries read on ${lastPage} pages)`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({ name: e.name, status: e.status, finma_url: e.finma_url, list_page: e.list_page })),
      source_url: LIST_BASE,
      excerpt: `${matches[0].name}: on "${LIST_NAME}", status ${matches[0].status || 'not stated'}`,
    };
  } catch (e) {
    return cc('other', `handler error: ${String(e).slice(0, 200)}`);
  }
}
