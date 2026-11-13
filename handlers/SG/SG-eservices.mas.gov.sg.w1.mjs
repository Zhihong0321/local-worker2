export const meta = {
  task: 'SG-eservices.mas.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_types', 'address', 'phone', 'website', 'detail_url'],
  canary: { found: 'DBS BANK LTD.', not_found: '新加坡虚构金融有限公司' },
};

const SEARCH = 'https://eservices.mas.gov.sg/fid/institution';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 100;   // the site's largest page size (?count=100)
const MAX_PAGES = 5;    // at most 500 results checked per name
const DEADLINE_MS = 40000;

// Legal-form spellings that are the same thing.
const LEGAL_CANON = { LIMITED: 'LTD', PRIVATE: 'PTE', BERHAD: 'BHD' };
const LEGAL_FORMS = new Set(['PTE', 'LTD', 'SDN', 'BHD', 'LLP', 'LLC', 'INC', 'PLC', 'CORP']);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function clean(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised name tokens: case, punctuation and legal-form spelling ignored. */
function tokens(str) {
  return String(str || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => LEGAL_CANON[t] || t);
}

/** True only when the listed name is the same company as the keyword. */
function sameCompany(keyword, listed) {
  const kw = tokens(keyword);
  const li = tokens(listed);
  if (!kw.length || !li.length) return false;
  if (kw.join(' ') === li.join(' ')) return true;
  // A keyword typed without a legal form may match the listed name with one (e.g. "DBS BANK" -> "DBS BANK LTD.").
  const kwHasLegal = kw.some((t) => LEGAL_FORMS.has(t));
  const kwCore = kw.filter((t) => !LEGAL_FORMS.has(t)).join(' ');
  const liCore = li.filter((t) => !LEGAL_FORMS.has(t)).join(' ');
  return !kwHasLegal && kwCore !== '' && kwCore === liCore;
}

function searchUrl(term, page) {
  return `${SEARCH}?${new URLSearchParams({ term, count: String(PER_PAGE), page: String(page) })}`;
}

/** One result card per licensed institution on the page. */
function parseCards(html) {
  const anchors = [...html.matchAll(/<a href="(\/fid\/institution\/detail\/[^"]+)">\s*<h3 class="header-inner-2">([\s\S]*?)<\/h3>/g)];
  return anchors.map((m, i) => {
    const start = m.index;
    const end = Math.min(anchors[i + 1] ? anchors[i + 1].index : html.length, start + 3000);
    const chunk = html.slice(start, end);
    const licence_types = [...chunk.matchAll(/<a class="FilterCategory"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((x) => clean(x[1]))
      .filter(Boolean);
    const website = decodeEntities((chunk.match(/<a class="font-resize" target="_blank" href="([^"]+)"/) || [])[1] || '');
    const phone = clean((chunk.match(/href="tel:[^"]*">([\s\S]*?)<\/a>/) || [])[1]);
    const address = clean((chunk.match(/alt="Address Icon"><\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/) || [])[1]);
    return {
      name: clean(m[2]),
      licence_types,
      address,
      phone,
      website,
      detail_url: new URL(m[1], SEARCH).href,
    };
  });
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await search(keyword);
  // On this Node build (Windows), exiting while a keep-alive socket is still closing aborts the process
  // (exit 127). A short pause lets the sockets settle before the runner exits; it does not change the answer.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return out;
}

async function search(keyword) {
  const started = Date.now();
  const term = String(keyword || '').trim();
  let lastUrl = SEARCH;
  try {
    if (!term) return couldnt('other', SEARCH, 'empty company name');

    const matches = [];
    let checked = 0;
    let truncated = false;
    for (let page = 1; ; page++) {
      if (page > 1 && Date.now() - started > DEADLINE_MS) return couldnt('timeout', lastUrl, 'stopped before the 60 s limit');
      const url = searchUrl(term, page);
      lastUrl = url;
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (/captcha|access denied|are you a robot/i.test(html)) return couldnt('blocked', url, 'bot or captcha page');
      const header = html.match(/<p><b>([\d,]+)<\/b>\s*result\(s\)<\/p>/);
      if (!header) return couldnt('layout_changed', url, clean(html));

      const hits = Number(header[1].replace(/,/g, ''));
      const cards = parseCards(html);
      if (hits > 0 && cards.length === 0) return couldnt('layout_changed', url, clean(html));

      checked += cards.length;
      for (const card of cards) if (sameCompany(term, card.name)) matches.push(card);
      if (matches.length) break;
      if (cards.length < PER_PAGE) break;           // last page of results
      if (page >= MAX_PAGES) { truncated = true; break; }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: lastUrl,
        excerpt: clean(matches.map((r) => `${r.name} | ${r.licence_types.join('; ')} | ${r.address}`).join(' || ')).slice(0, 300),
      };
    }
    if (truncated) {
      return couldnt('other', lastUrl, `no exact match in the first ${checked} results; the list is longer than the handler checks`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `0 matching names for "${term}" among ${checked} results`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', lastUrl, String(err?.message || err));
  }
}
