export const meta = {
  task: 'CH-gastrosuisse.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'canton', 'category', 'phone', 'street', 'postal_code_city', 'website'],
  canary: { found: 'Barracuda Hotel', not_found: 'Hotel Nirgendwo Irgendwo AG' },
};

// Public GastroSuisse page: "Klassifizierte Hotels" (Sterne-Label), one static HTML list, grouped by canton.
// It lists only Sterne-Label hotels. The membership itself is not published (member portal is login-only).
const LIST_URL = 'https://gastrosuisse.ch/de/service/hotelklassifikation/klassifizierte-hotels';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_HOTELS = 100; // the page lists about 340 hotels; fewer means the layout changed
const LEGAL_FORMS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'kg', 'ltd', 'llc', 'inc', 'co', 'srl', 'sprl']);

function decodeEntities(s) {
  const named = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', szlig: 'ß' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in named ? named[n] : m));
}

/** Plain text of an HTML fragment. Scripts and noscript blocks (the e-mail obfuscation) are dropped. */
function cleanText(html) {
  const noScripts = (html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  return decodeEntities(noScripts.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Name key: case, accents, punctuation and trailing legal form ignored (ACME AG = Acme). */
function normName(s) {
  let t = (s || '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase();
  t = t.replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const toks = t.split(' ').filter(Boolean);
  while (toks.length > 1 && LEGAL_FORMS.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

/**
 * One table = one address block. Each row whose first cell is bold starts a venue (name, phone);
 * the other rows give the shared street, postal code + city and website. A table can hold several venues.
 */
function parseTable(tableHtml) {
  const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const entries = [];
  const addr = { street: '', postal_code_city: '', website: '' };
  for (const r of rows) {
    const cells = r.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
    if (!cells.length) continue;
    const nameMatch = cells[0].match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    if (nameMatch) {
      const name = cleanText(nameMatch[1]);
      if (name) entries.push({ name, phone: cells[1] ? cleanText(cells[1]) : '' });
      continue;
    }
    const text = cleanText(cells[0]);
    if (/^\d{4}\s+\S/.test(text)) addr.postal_code_city = addr.postal_code_city || text;
    else if (text) addr.street = addr.street || text;
    const hrefMatch = r.match(/<a\s[^>]*href="([^"]+)"/i);
    if (hrefMatch && !addr.website) addr.website = hrefMatch[1];
  }
  return entries.map((e) => ({ ...e, ...addr }));
}

/** Every hotel on the list, with its canton and star category. */
function parseList(html) {
  const hotels = [];
  let canton = '';
  let category = '';
  const re = /<div[^>]*canton-configuration[^>]*>|<h4[^>]*auto-listTitle[^>]*>([\s\S]*?)<\/h4>|<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('<div')) {
      const t = m[0].match(/data-title="([^"]*)"/i);
      canton = t ? cleanText(t[1]) : '';
    } else if (m[1] !== undefined) {
      category = cleanText(m[1]);
    } else if (m[2] !== undefined && canton && category) {
      for (const h of parseTable(m[2])) hotels.push({ canton, category, ...h });
    }
  }
  return hotels;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
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
    if (/captcha|cf-challenge|just a moment/i.test(html.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'bot check page' };
    }
    if (!html.includes('auto-listTitle') || !html.includes('canton-configuration')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
    }

    const hotels = parseList(html);
    if (hotels.length < MIN_HOTELS) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: `only ${hotels.length} hotels parsed` };
    }

    const key = normName(kw);
    const matches = key ? hotels.filter((h) => normName(h.name) === key) : [];

    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `"${kw}" is not on the GastroSuisse Sterne-Label hotel list (${hotels.length} hotels checked). The list covers only labelled hotels, not all members.`,
      };
    }

    const records = matches.map((h) => ({
      name: h.name,
      canton: h.canton,
      category: h.category,
      phone: h.phone,
      street: h.street,
      postal_code_city: h.postal_code_city,
      website: h.website,
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: records.map((r) => `${r.name} (${r.category}, ${r.canton}) ${r.postal_code_city}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
