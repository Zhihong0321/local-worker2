export const meta = { task: 'DE-deutsche-startups.de', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'profile_url', 'company_name', 'website', 'managing_directors', 'founders', 'founded', 'location', 'business_model'],
  canary: { found: '3NRG GmbH', not_found: 'Müllerschmidt Nordlicht Zukunftsfabrik GmbH' } };

// Startups A-Z directory of deutsche-startups.de: one static list page, one profile page per company.
const BASE = 'https://www.deutsche-startups.de';
const LIST_URL = `${BASE}/verzeichnisse/startups-a-z/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TOTAL_BUDGET_MS = 55000;
const MIN_LIST_ENTRIES = 200; // the directory holds about 1,100 entries; fewer means the page is not the list

// Legal forms and domain tails are ignored when comparing names ("3NRG GmbH" = "3NRG", "Stoffe.de" = "Stoffe").
const IGNORED_TOKENS = new Set(['gmbh', 'mbh', 'ag', 'kg', 'ug', 'gbr', 'ohg', 'co', 'se', 'ev', 'ltd', 'limited', 'inc', 'llc',
  'sa', 'sarl', 'sas', 'bv', 'ab', 'oy', 'srl', 'sl', 'de', 'com', 'net', 'org', 'eu', 'io']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: case, umlauts, punctuation and legal form removed. */
function core(s) {
  const folded = decodeEntities(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return folded.split(/[^a-z0-9]+/).filter((t) => t && !IGNORED_TOKENS.has(t)).join('');
}

function timeoutError() {
  const e = new Error('the handler ran out of its time budget');
  e.name = 'TimeoutError';
  return e;
}

/** One GET with a browser-like user-agent; the timeout never runs past the handler's overall budget. */
async function getPage(url, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) throw timeoutError();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
    signal: AbortSignal.timeout(Math.min(25000, left)),
  });
  const body = await res.text();
  return { status: res.status, ok: res.ok, body };
}

/** Returns a couldnt_check answer when the response is a refusal, otherwise null. */
function refusal(res, url) {
  const short = res.body.length < 5000;
  if (res.status === 403 || res.status === 429 || (short && /captcha|just a moment|access denied|too many requests/i.test(res.body))) {
    return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
  }
  return null;
}

function failure(err, url) {
  const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(err?.message || err).slice(0, 300) };
}

/** Reads a profile page's "Firmenname / URL / Geschäftsführer ..." list. */
async function readProfile(url, deadline) {
  const res = await getPage(url, deadline);
  const blocked = refusal(res, url);
  if (blocked) return { error: blocked };
  const fields = {};
  const re = /<li class="(company|url|head|founder|founded|location|businessmodel)"><span>[^<]*<\/span>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(res.body))) fields[m[1]] = cleanText(m[2]);
  if (!('company' in fields)) {
    return { error: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: res.body.slice(0, 300) } };
  }
  return {
    fields: {
      company_name: fields.company,
      website: fields.url || '',
      managing_directors: fields.head || '',
      founders: fields.founder || '',
      founded: fields.founded || '',
      location: fields.location || '',
      business_model: fields.businessmodel || '',
    },
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty keyword' };

    // 1. The A-Z list: named entries (link text) and unnamed entries (logo-only links, slug only).
    const list = await getPage(LIST_URL, deadline);
    const listRefusal = refusal(list, LIST_URL);
    if (listRefusal) return listRefusal;

    const named = new Map();   // slug -> listed name
    const unnamed = new Set(); // slug with no text in the list
    const anchorRe = /<a href="https?:\/\/(?:www\.)?deutsche-startups\.de\/verzeichnisse\/startups-a-z\/([^"\/?#]+)\/"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(list.body))) {
      const name = cleanText(m[2]);
      if (name) { if (!named.has(m[1])) named.set(m[1], name); } else unnamed.add(m[1]);
    }
    for (const slug of named.keys()) unnamed.delete(slug);
    if (named.size + unnamed.size < MIN_LIST_ENTRIES) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: list.body.slice(0, 300) };
    }

    const want = core(kw);
    const profileSlugs = [];

    // 2. Named entries: compare normalised names.
    for (const [slug, name] of named) if (want && core(name) === want) profileSlugs.push({ slug, name });

    if (profileSlugs.length) {
      const records = [];
      const notes = [];
      for (const { slug, name } of profileSlugs) {
        const url = `${BASE}/verzeichnisse/startups-a-z/${slug}/`;
        const rec = { name, profile_url: url, company_name: '', website: '', managing_directors: '', founders: '', founded: '', location: '', business_model: '' };
        try {
          const p = await readProfile(url, deadline);
          if (p.error) notes.push(`profile not read (${p.error.reason}, ${p.error.excerpt})`);
          else Object.assign(rec, p.fields);
        } catch (err) {
          notes.push(`profile not read (${failure(err, url).reason})`);
        }
        records.push(rec);
      }
      return {
        status: 'found',
        reason: '',
        records,
        source_url: LIST_URL,
        excerpt: `Listed in Startups A-Z as "${profileSlugs.map((x) => x.name).join('", "')}"` + (notes.length ? `; ${notes.join('; ')}` : ''),
      };
    }

    // 3. Unnamed entries: the URL slug is the only clue, so a slug match must be confirmed on the profile page.
    const candidates = [...unnamed].filter((slug) => want && core(slug.replace(/-/g, ' ')) === want).slice(0, 2);
    const confirmed = [];
    const unconfirmable = [];
    for (const slug of candidates) {
      const url = `${BASE}/verzeichnisse/startups-a-z/${slug}/`;
      const p = await readProfile(url, deadline);
      if (p.error) return p.error;
      if (!p.fields.company_name) { unconfirmable.push(url); continue; } // logo-only entries show no company name
      if (core(p.fields.company_name) === want) {
        confirmed.push({ name: p.fields.company_name, profile_url: url, ...p.fields });
      }
    }
    if (confirmed.length) {
      return { status: 'found', reason: '', records: confirmed, source_url: confirmed[0].profile_url,
        excerpt: `Confirmed on the profile page of "${confirmed[0].company_name}"` };
    }
    if (unconfirmable.length) {
      // The slug fits the name but nothing on the site confirms it: that is not a proof of absence.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: unconfirmable[0],
        excerpt: `Directory entry ${unconfirmable[0]} has a URL slug that fits this name, but its profile shows no company name; cannot confirm.` };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_URL,
      excerpt: `No match for "${kw}" in ${named.size} named entries of the Startups A-Z list; ${unnamed.size} entries show no name and were compared by URL slug only.`,
    };
  } catch (err) {
    return failure(err, LIST_URL);
  }
}
