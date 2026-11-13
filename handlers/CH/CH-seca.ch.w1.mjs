// SECA (seca.ch) company lookup.
// SECA publishes its full member directory on one plain HTML page (/en/find-members/, about 580 members, no paging).
// The site's own search box only filters that page in the browser, so the handler reads the whole list with one GET,
// matches the company name exactly after normalising it, and reads the profile page of each match for its details.

export const meta = {
  task: 'CH-seca.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'status', 'type_of_firm', 'phone', 'homepage', 'street', 'po_box', 'zip', 'town', 'country',
    'year_established', 'profile_url', 'detail_status'],
  canary: { found: 'Alantra AG', not_found: 'Zürcher Unbekannte Beteiligungsgesellschaft AG' },
};

const SITE = 'https://www.seca.ch';
const LIST_URL = 'https://www.seca.ch/en/find-members/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en,de;q=0.8' };
const MAX_DETAIL_FETCHES = 5;

// Legal forms that are ignored when comparing names (lower case, dots removed, accents folded).
const LEGAL = new Set(['ag', 'sa', 'sarl', 'sagl', 'sas', 'gmbh', 'ltd', 'limited', 'llc', 'inc', 'kg', 'kgaa', 'se',
  'srl', 'spa', 'bv', 'nv', 'ltda', 'plc', 'sl', 'slu', 'co', 'corp']);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function codePoint(n) {
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** Decode the HTML entities the site uses (&#xE4; &#x2B; &amp; ...). */
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

/** Visible text of an HTML fragment, one line of words. */
function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Words of a company name: lower case, accents folded, dots dropped, punctuation turned into spaces. */
function words(raw) {
  const t = decode(raw).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/đ/g, 'd')
    .replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? t.split(' ') : [];
}

/** Name without its trailing legal form, e.g. "Alantra AG" -> "alantra". */
function normalise(raw) {
  const w = words(raw);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/**
 * The set of names a company can be matched by. The full name is always one. A name with a bracket that ends in a
 * legal form, such as "Allegory Capital (Kainjoo SA)", also matches by the part outside and inside the brackets.
 */
function nameKeys(raw) {
  const keys = new Set();
  const add = (s) => { const k = normalise(s); if (k) keys.add(k); };
  add(raw);
  const m = String(raw).match(/\(([^()]*)\)/);
  if (m) {
    const inner = words(m[1]);
    if (inner.length && LEGAL.has(inner[inner.length - 1])) {
      add(String(raw).replace(m[0], ' '));
      add(m[1]);
    }
  }
  return keys;
}

/** Directory rows: one per member box, with the profile link and the company name shown in the box. */
function parseDirectory(html) {
  const rows = [];
  for (const chunk of html.split('class="memberSingleBox"').slice(1)) {
    const href = chunk.match(/<a[^>]+href="(\/en\/find-members\/[^"#?]+)"/i);
    const title = chunk.match(/<h3 class="title">([\s\S]*?)<\/h3>/i);
    if (!href || !title) continue;
    const name = cleanText(title[1]);
    if (!name) continue;
    rows.push({ name, href: new URL(href[1], SITE).href, keys: nameKeys(name) });
  }
  return rows;
}

/** Profile page: "property-label" / "property-value" pairs. Returns a Map label -> raw value HTML. */
function parseProfile(html) {
  const map = new Map();
  const re = /<div class="property-label">\s*([\s\S]*?)\s*<\/div>\s*<div class="property-value">\s*([\s\S]*?)\s*<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const label = cleanText(m[1]);
    if (!map.has(label)) map.set(label, m[2]);
  }
  return map;
}

function profileFields(html) {
  const map = parseProfile(html);
  const val = (label) => {
    const raw = map.get(label);
    if (raw == null) return '';
    const t = cleanText(raw);
    return t === '-' ? '' : t;
  };
  const homepageRaw = map.get('Homepage') || '';
  const href = homepageRaw.match(/href="([^"]+)"/i);
  return {
    company_name: val('Company Name'),
    status: val('Status'),
    type_of_firm: val('Type of Firm'),
    phone: val('Phone'),
    homepage: href ? href[1] : val('Homepage'),
    street: val('Street'),
    po_box: val('PO Box'),
    zip: val('Zip'),
    town: val('Town'),
    country: val('Country'),
    year_established: val('Year of Establishment'),
  };
}

async function readProfile(row) {
  try {
    const res = await fetch(row.href, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { detail_status: `HTTP ${res.status}` };
    const html = await res.text();
    if (!/property-label/.test(html)) return { detail_status: 'layout_changed' };
    return { ...profileFields(html), detail_status: 'ok' };
  } catch (err) {
    return { detail_status: 'failed: ' + (err && err.name === 'TimeoutError' ? 'timeout' : String(err && err.message || err).slice(0, 120)) };
  }
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = typeof keyword === 'string' ? keyword.trim() : '';
    const want = nameKeys(input);
    if (!input || want.size === 0) return out('couldnt_check', 'other', [], LIST_URL, 'no company name was given');

    const res = await fetch(LIST_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', [], LIST_URL, `HTTP ${res.status}`);
    if (!res.ok) return out('couldnt_check', 'http_error', [], LIST_URL, `HTTP ${res.status}`);

    const html = await res.text();
    const rows = parseDirectory(html);
    if (rows.length === 0) {
      if (/captcha|cf-chl|access denied|attention required|verify you are (a )?human|enable javascript and cookies/i.test(html)) {
        return out('couldnt_check', 'blocked', [], LIST_URL, 'bot or access check page instead of the member list');
      }
      return out('couldnt_check', 'layout_changed', [], LIST_URL, 'no member entries found on the members page: ' + cleanText(html).slice(0, 200));
    }

    const hits = rows.filter((r) => [...r.keys].some((k) => want.has(k)));
    if (hits.length === 0) {
      return out('not_found', '', [], LIST_URL, `"${input}" is not among the ${rows.length} members listed`);
    }

    const read = hits.slice(0, MAX_DETAIL_FETCHES);
    const details = await Promise.all(read.map(readProfile));
    const records = hits.map((row, i) => {
      const d = i < read.length ? details[i] : { detail_status: `not read (more than ${MAX_DETAIL_FETCHES} matches)` };
      return {
        name: row.name,
        status: d.status || '',
        type_of_firm: d.type_of_firm || '',
        phone: d.phone || '',
        homepage: d.homepage || '',
        street: d.street || '',
        po_box: d.po_box || '',
        zip: d.zip || '',
        town: d.town || '',
        country: d.country || '',
        year_established: d.year_established || '',
        profile_url: row.href,
        detail_status: d.detail_status,
      };
    });
    return out('found', '', records, records[0].profile_url,
      `SECA member list: ${hits.map((h) => h.name).join('; ')}`);
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return out('couldnt_check', reason, [], LIST_URL, String(err && err.message || err).slice(0, 300));
  }
}
