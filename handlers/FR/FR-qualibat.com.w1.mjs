export const meta = {
  task: 'FR-qualibat.com',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'postcode_city', 'qualifications_count', 'fiche_url'],
  canary: { found: 'BOUYGUES BATIMENT CENTRE SUD-OUEST', not_found: 'SOCIETE INEXISTANTE ZORGLUB' },
};

const BASE = 'https://www.qualibat.com';
const DIRECTORY = `${BASE}/annuaire-entreprises-qualifiees`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10;
const DEADLINE_MS = 50000;

const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'sarlu', 'eurl', 'sa', 'snc', 'sci', 'scop', 'selarl', 'sel', 'ei', 'gie', 'scm', 'se', 'sc']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0*39;|&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Upper/lower case, accents, punctuation and spaces removed. */
function normalize(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalised name with trailing legal-form words removed, e.g. "ACME SAS" -> "acme". */
function coreName(str) {
  const words = normalize(str).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function headers(extra) {
  return { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5', ...extra };
}

function cookieHeader(res, prev) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = new Map();
  for (const part of (prev || '').split('; ').filter(Boolean)) {
    const [k, ...v] = part.split('=');
    jar.set(k, v.join('='));
  }
  for (const c of raw) {
    const [pair] = c.split(';');
    const [k, ...v] = pair.split('=');
    if (k) jar.set(k.trim(), v.join('='));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function failure(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Parse the result cards from one results page (the JSON "render" HTML). */
function parseCards(render) {
  const parts = render.split('data-map-target="point"').slice(1);
  return parts.map((part) => {
    const dataName = part.match(/data-name="([^"]*)"/);
    const h3 = part.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const addr = part.match(/<div class="text-18 mb-\[14px\] text-primary-dark">([\s\S]*?)<\/div>/);
    const fiche = part.match(/href="(\/entreprises\/[^"]+)"/);
    const quals = part.match(/(\d+) qualification\(s\)/);
    const addressLines = addr ? cleanText(addr[1].replace(/<br\s*\/?>/gi, ', ')).replace(/\s+,/g, ',') : '';
    const cityMatch = addr ? addr[1].match(/<span class="uppercase">([\s\S]*?)<\/span>/) : null;
    return {
      name: decodeEntities(dataName ? dataName[1] : cleanText(h3 ? h3[1] : '')),
      address: addressLines,
      postcode_city: cityMatch ? cleanText(cityMatch[1]) : '',
      qualifications_count: quals ? Number(quals[1]) : null,
      fiche_url: fiche ? new URL(fiche[1], BASE).href : '',
    };
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    // Step 1: open the directory page to get a session cookie and the search form token.
    const pageRes = await fetch(DIRECTORY, {
      headers: headers({ 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return failure('blocked', DIRECTORY, `HTTP ${pageRes.status}`);
    }
    if (!pageRes.ok) {
      return failure('http_error', DIRECTORY, `HTTP ${pageRes.status}`);
    }
    let cookies = cookieHeader(pageRes, '');
    const pageHtml = await pageRes.text();
    if (/captcha|cf-chl|challenge-platform/i.test(pageHtml)) {
      return failure('blocked', DIRECTORY, 'bot check or captcha on the directory page');
    }
    const tokenMatch = pageHtml.match(/id="form_quick_society__token" name="form_quick_society\[_token\]" value="([^"]+)"/);
    if (!tokenMatch || !pageHtml.includes('form_quick_society')) {
      return failure('layout_changed', DIRECTORY, pageHtml.slice(0, 200));
    }
    const token = tokenMatch[1];

    // The site's own search form matches on the name without the legal form, so search that part.
    const term = (() => {
      const words = (keyword || '').trim().split(/\s+/).filter(Boolean);
      while (words.length > 1 && LEGAL_FORMS.has(normalize(words[words.length - 1]))) words.pop();
      return words.join(' ') || (keyword || '').trim();
    })();
    const wanted = coreName(keyword);
    if (!wanted) {
      return failure('other', DIRECTORY, 'the company name is empty after removing the legal form');
    }

    // Step 2: search, one results page at a time, until the last page or a match is read.
    const matches = [];
    let seen = 0;
    let lastPage = 1;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) {
        return failure('timeout', DIRECTORY, 'the search did not finish in time');
      }
      const body = new URLSearchParams({
        'form_quick_society[user_type]': 'professional',
        'form_quick_society[quicksearch]': term,
        'form_quick_society[_token]': token,
        'form_quick_society[send]': 'Rechercher',
        'is_final': 'true',
      });
      if (page > 1) body.set('page', String(page));

      const res = await fetch(DIRECTORY, {
        method: 'POST',
        headers: headers({
          'Accept': 'application/json, text/html, */*',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': DIRECTORY,
          'Origin': BASE,
          'Cookie': cookies,
        }),
        body,
        signal: AbortSignal.timeout(25000),
      });
      cookies = cookieHeader(res, cookies);
      if (res.status === 403 || res.status === 429) {
        return failure('blocked', DIRECTORY, `HTTP ${res.status} on search`);
      }
      if (!res.ok) {
        return failure('http_error', DIRECTORY, `HTTP ${res.status} on search`);
      }
      let json;
      try {
        json = JSON.parse(await res.text());
      } catch {
        return failure('layout_changed', DIRECTORY, 'the search answer is not JSON');
      }
      if (!json || json.success !== true || typeof json.render !== 'string') {
        return failure('layout_changed', DIRECTORY, 'the search answer has no results block');
      }

      const render = json.render;
      if (/Aucun résultat/i.test(render)) {
        return {
          status: 'not_found',
          reason: '',
          records: [],
          source_url: DIRECTORY,
          excerpt: `Aucun résultat ne correspond à votre demande (search: ${term})`,
        };
      }
      const cards = parseCards(render);
      if (cards.length === 0 && page === 1) {
        return failure('layout_changed', DIRECTORY, 'results text without result cards');
      }
      seen += cards.length;
      for (const card of cards) {
        if (card.name && coreName(card.name) === wanted) matches.push(card);
      }

      const pageNumbers = [...render.matchAll(/data-page="(\d+)"/g)].map((m) => Number(m[1]));
      lastPage = pageNumbers.length ? Math.max(...pageNumbers) : 1;
      if (page >= lastPage || cards.length === 0) break;
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matches[0].fiche_url || DIRECTORY,
        excerpt: `Qualibat directory: ${matches.length} matching entr${matches.length > 1 ? 'ies' : 'y'} for "${term}"`,
      };
    }

    if (lastPage > MAX_PAGES) {
      return failure('other', DIRECTORY, `more than ${MAX_PAGES} result pages for "${term}"; the match was not reached`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: DIRECTORY,
      excerpt: `${seen} result(s) for "${term}", none with this company name`,
    };
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return failure('timeout', DIRECTORY, String(err?.message || err));
    }
    return failure('other', DIRECTORY, String(err?.message || err));
  }
}
