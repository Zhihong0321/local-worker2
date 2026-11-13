export const meta = {
  task: 'FR-indexa.fr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'legal_form', 'siret', 'vat', 'created', 'ape', 'effectif', 'category_slug', 'url'],
  canary: { found: 'H2O', not_found: 'Pralvinoche' },
};

const BASE = 'https://indexa.fr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5; // result pages read per search
const MAX_DETAILS = 5; // matching records opened
const START_LIMIT_MS = 30000; // no new request starts after this; with the 25 s fetch timeout the call ends under 60 s
const LEGAL = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'snc', 'sci', 'scp', 'selarl', 'selas', 'sel', 'eirl', 'ei', 'earl', 'sc', 'sce', 'scea', 'sca', 'sep', 'gie', 'sns', 'scs', 'scop']);

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case words without accents; punctuation and apostrophes split words. */
function words(s) {
  return decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Normalised name for matching: legal form words removed, so "H2O SAS" equals "H2O". */
function key(s) {
  const w = words(s).filter((x) => !LEGAL.has(x));
  return (w.length ? w : words(s)).join('');
}

/** The search text: the name as typed, without the legal form words. */
function searchText(keyword) {
  const kept = String(keyword).trim().split(/\s+/).filter((p) => !LEGAL.has(words(p).join('')));
  return kept.join(' ') || String(keyword).trim();
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 500) };
}

function failFromError(e, url) {
  const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return fail(timedOut ? 'timeout' : 'other', url, timedOut ? 'no answer within 25 s' : String((e && e.message) || e));
}

async function getPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, body: await res.text() };
}

/** Result cards on a search page: { href, name (shown text), fullName (title attribute) }. */
function parseCards(html) {
  const out = [];
  const re = /<h3 class="card-title"><a href="([^"]+)" title="Voir la fiche : ([^"]*)">([\s\S]*?)<\/a><\/h3>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ href: decode(m[1]), name: clean(m[3]), fullName: clean(m[2]) });
  }
  return out;
}

/** Detail page (/entreprise/<slug>/<category>): name, address, legal block. Null if the layout is not as expected. */
function parseDetail(html, card, url) {
  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/i);
  if (!h1) return null;
  const addr = html.match(/<p class="business-summary-details-address">([\s\S]*?)<\/p>/i);
  const field = (label) => {
    const m = html.match(new RegExp(label + '\\s*:\\s*([\\s\\S]*?)</p>', 'i'));
    return m ? clean(m[1]) : '';
  };
  return {
    name: clean(h1[1]) || card.name,
    address: addr ? addr[1].split(/<br\s*\/?>/i).map(clean).filter(Boolean).join(', ') : '',
    legal_form: field('Forme juri\\S*'),
    created: field('Date Cr[^<:]*'),
    ape: field('Code APE'),
    effectif: field('Effectif'),
    siret: field('N°SIRET'),
    vat: field('N°TVA'),
    category_slug: new URL(url).pathname.split('/').filter(Boolean)[2] || '',
    url,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const started = Date.now();
    const canStart = () => Date.now() - started < START_LIMIT_MS;
    const k = key(keyword);
    if (!k) return fail('other', BASE, 'empty company name');
    const firstUrl = `${BASE}/recherche?search-words=${encodeURIComponent(searchText(keyword))}`;

    // Step 1: read the result pages and collect cards whose normalised name equals the keyword's.
    const matches = [];
    let cardsSeen = 0;
    let pagesRead = 0;
    let exhausted = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && !canStart()) break;
      const url = page === 1 ? firstUrl : `${firstUrl}&page=${page}`;
      let r;
      try { r = await getPage(url); } catch (e) { return failFromError(e, url); }
      if (r.status === 403 || r.status === 429) return fail('blocked', url, `HTTP ${r.status}`);
      if (r.status !== 200) return fail('http_error', url, `HTTP ${r.status}`);

      const cards = parseCards(r.body);
      if (!cards.length) {
        if (/Aucun résultat trouvé/.test(r.body)) {
          if (page === 1) {
            return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: 'Aucun résultat trouvé dans INDEXA' };
          }
          exhausted = true;
          break;
        }
        const blocked = /cf-chl|challenge-platform|Just a moment|captcha/i.test(r.body);
        return fail(blocked ? 'blocked' : 'layout_changed', url, clean(r.body).slice(0, 300));
      }

      pagesRead++;
      for (const c of cards) {
        cardsSeen++;
        if (key(c.name) === k || key(c.fullName) === k) matches.push(c);
      }
      exhausted = !/class="paginate-next"/.test(r.body);
      if (exhausted) break;
    }

    if (!matches.length) {
      if (!exhausted) {
        return fail('other', firstUrl, `no exact name match on the first ${pagesRead} result page(s); the search has more pages`);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `${cardsSeen} result(s) on ${pagesRead} page(s), none named "${keyword}"`,
      };
    }

    // Step 2: open each matching company's detail page.
    const records = [];
    for (const m of matches.slice(0, MAX_DETAILS)) {
      const durl = new URL(m.href, BASE).href;
      if (!canStart()) return fail('timeout', durl, 'time budget used before every matching record was read');
      let d;
      try { d = await getPage(durl); } catch (e) { return failFromError(e, durl); }
      if (d.status === 403 || d.status === 429) return fail('blocked', durl, `HTTP ${d.status}`);
      if (d.status !== 200) return fail('http_error', durl, `HTTP ${d.status}`);
      const rec = parseDetail(d.body, m, durl);
      if (!rec) return fail('layout_changed', durl, clean(d.body).slice(0, 300));
      records.push(rec);
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.url,
      excerpt: `${first.name} | ${first.address} | SIRET ${first.siret}`.slice(0, 500),
    };
  } catch (err) {
    return fail('other', BASE, String((err && err.message) || err));
  }
}
