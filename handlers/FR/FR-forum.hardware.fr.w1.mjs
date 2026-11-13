export const meta = {
  task: 'FR-forum.hardware.fr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['title', 'thread_url', 'thread_id', 'replies', 'last_message_date'],
  canary: { found: 'LDLC', not_found: 'Établissements Zqxvbrlwq' },
};

const BASE = 'https://forum.hardware.fr';
const SEARCH_URL = `${BASE}/search.php?config=hfr.inc`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
};
// Legal forms, dropped only when they close the name ("ACME SAS", "ACME S.A.S.").
const LEGAL = new Set(['sas', 'sasu', 'sarl', 'sarlu', 'eurl', 'sa', 'sci', 'snc', 'sca', 'scop', 'selarl']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê',
  agrave: 'à', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', icirc: 'î', ugrave: 'ù', euro: '€', hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—',
};

function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case, accents removed, punctuation turned into single spaces. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The name words without a trailing legal form. */
function coreWords(keyword) {
  const words = String(keyword || '').trim().split(/\s+/).filter((w) => fold(w));
  while (words.length && LEGAL.has(fold(words[words.length - 1]).replace(/ /g, ''))) words.pop();
  return words;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function looksBlocked(html) {
  return /captcha|cf-chl|challenge-platform|Attention Required! \| Cloudflare/i.test(html);
}

function call(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const r = await lookupInner(keyword);
  await sleep(500); // let the closing HTTP sockets finish before the runner exits (Windows libuv assert, exit 127)
  return r;
}

async function lookupInner(keyword) {
  let sourceUrl = SEARCH_URL;
  try {
    const words = coreWords(keyword);
    if (!words.length) {
      return answer('couldnt_check', 'other', [], SEARCH_URL, 'no company name left after removing the legal form');
    }
    const term = words.join(' ');
    const phrase = ` ${fold(term)} `;

    // Step 1: the search is posted; the site answers with a "please wait" page that names the results URL.
    const form = new URLSearchParams({
      hash_check: '', search: term, pseud: '', cat: '', subcat: '0', searchtype: '1', titre: '1',
      daterange: '2', resSearch: '50', orderSearch: '1', recherches: '1', Valider: 'Valider',
    });
    const post = await call(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/` },
      body: form.toString(),
    });
    if (post.status === 403 || post.status === 429) {
      return answer('couldnt_check', 'blocked', [], SEARCH_URL, `HTTP ${post.status}`);
    }
    if (!post.ok) {
      return answer('couldnt_check', 'http_error', [], SEARCH_URL, `HTTP ${post.status}`);
    }
    let html = await post.text();
    if (looksBlocked(html)) {
      return answer('couldnt_check', 'blocked', [], SEARCH_URL, clean(html).slice(0, 300));
    }

    // Step 2: fetch the results URL the wait page names (the site redirects it to the results page).
    const refresh = html.match(/<meta http-equiv="Refresh" content="[^"]*url=([^"]+)"/i);
    if (refresh) {
      await sleep(1500);
      const resultsUrl = new URL(decode(refresh[1]), BASE).href;
      const res = await call(resultsUrl);
      if (res.status === 403 || res.status === 429) {
        return answer('couldnt_check', 'blocked', [], resultsUrl, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return answer('couldnt_check', 'http_error', [], resultsUrl, `HTTP ${res.status}`);
      }
      html = await res.text();
      sourceUrl = res.url || resultsUrl;
      if (looksBlocked(html)) {
        return answer('couldnt_check', 'blocked', [], sourceUrl, clean(html).slice(0, 300));
      }
    }

    // Step 3: read the results page.
    if (/aucune r.ponse n.a .t. trouv/i.test(html)) {
      return answer('not_found', '', [], sourceUrl, `Forum search for "${term}": no thread found`);
    }
    if (!/a trouv. des r.sultats/i.test(html)) {
      return answer('couldnt_check', 'layout_changed', [], sourceUrl, clean(html).slice(0, 300));
    }

    const rows = [];
    for (const chunk of html.split(/<tr class="sujet /).slice(1)) {
      const a = chunk.match(/<a href="(\/hfr\/[^"]+)" class="cCatTopic" title="Sujet n\D*(\d+)">([\s\S]*?)<\/a>/);
      if (!a) continue;
      const replies = (chunk.match(/<td class="sujetCase7">\s*(\d+)\s*<\/td>/) || [])[1] || '';
      const last = (chunk.match(/<td class="sujetCase9[^"]*"><a [^>]*>([\s\S]*?)<br/) || [])[1] || '';
      rows.push({
        title: clean(a[3]),
        thread_url: new URL(decode(a[1]), BASE).href,
        thread_id: a[2],
        replies,
        last_message_date: clean(last),
      });
    }
    if (!rows.length) {
      return answer('couldnt_check', 'layout_changed', [], sourceUrl, 'results page says threads were found but no thread row parsed');
    }

    // The company must be in the thread title as whole words, not just similar words.
    const matches = rows.filter((r) => ` ${fold(r.title)} `.includes(phrase));
    if (!matches.length) {
      return answer('not_found', '', [], sourceUrl,
        `Forum search for "${term}": ${rows.length} thread(s) matched the words, none has the name in its title`);
    }
    return answer('found', '', matches.slice(0, 50).map(({ title, thread_url, thread_id, replies, last_message_date }) => ({
      title, thread_url, thread_id, replies, last_message_date,
    })), sourceUrl, `${matches.length} thread title(s) contain "${term}", e.g. "${matches[0].title}"`);
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return answer('couldnt_check', reason, [], sourceUrl, String(err?.message || err));
  }
}
