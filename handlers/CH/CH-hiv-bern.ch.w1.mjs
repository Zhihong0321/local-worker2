export const meta = { task: 'CH-hiv-bern.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'location', 'industry', 'noga_code', 'section'],
  canary: { found: 'A 115 Gravures SA', not_found: 'Nichtexistierende Musterfirma AG' } };

// The HIV Bern site (www.hiv-bern.ch) now answers only with a 301 to www.bern-cci.ch (its certificate has expired).
// The member lists live on bern-cci.ch, one static page per section. Thun-Oberland publishes no member list.
const OVERVIEW_URL = 'https://www.bern-cci.ch/de/mitgliedschaft/mitgliederuebersicht';
const LISTS = [
  { section: 'Bern', url: 'https://www.bern-cci.ch/bern/mitglieder/mitgliederliste' },
  { section: 'Biel-Seeland / Berner Jura', url: 'https://www.bern-cci.ch/biel-jura/de/mitglieder/mitgliederliste' },
  { section: 'Emmental', url: 'https://www.bern-cci.ch/emmental/mitglieder/mitgliederliste' },
  { section: 'Lyss-Aarberg', url: 'https://www.bern-cci.ch/lyss/mitglieder/mitgliederliste' },
  { section: 'WVO Oberaargau', url: 'https://www.bern-cci.ch/wvo/mitglieder/mitgliederliste' },
];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};
// Legal forms that are dropped on both sides before comparing (Swiss forms).
const LEGAL_FORMS = new Set(['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'kg', 'ltd', 'llc']);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: lower case, no accents, '&' as 'und', no punctuation or spaces, no legal form. */
function normalize(s) {
  const t = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/&/g, ' und ');
  return t.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !LEGAL_FORMS.has(w)).join('');
}

/** One row per member: <div class="row nogaRow download-body ..." rel="NOGA"> with three <p> blocks (name, place, branch). */
function parseRows(html) {
  const starts = [];
  const re = /<div class="row nogaRow download-body[^"]*" rel="(\d*)">/g;
  let m;
  while ((m = re.exec(html))) starts.push({ at: m.index + m[0].length, noga: m[1] });
  const rows = [];
  starts.forEach((st, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : html.length;
    const ps = [...html.slice(st.at, end).matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => x[1]);
    if (ps.length < 3) return;
    const name = cleanText(ps[0].split(/<br\s*\/?>/i)[0]);
    if (!name) return;
    rows.push({ name, location: cleanText(ps[1]), industry: cleanText(ps[2]), noga_code: st.noga });
  });
  return rows;
}

async function fetchList(list) {
  try {
    const res = await fetch(list.url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { ...list, error: true, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ...list, error: true, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const rows = parseRows(await res.text());
    if (!rows.length) return { ...list, error: true, reason: 'layout_changed', excerpt: 'no member rows on the page' };
    return { ...list, rows };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ...list, error: true, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalize(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: OVERVIEW_URL, excerpt: 'empty company name' };
    }

    const results = await Promise.all(LISTS.map(fetchList));
    const records = [];
    const failed = [];
    let searched = 0;
    for (const r of results) {
      if (r.error) { failed.push(r); continue; }
      searched += r.rows.length;
      for (const row of r.rows) {
        if (normalize(row.name) === key) {
          records.push({ name: row.name, location: row.location, industry: row.industry, noga_code: row.noga_code, section: r.section, list_url: r.url });
        }
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].list_url,
        excerpt: `${records[0].name} is listed as a member (${records[0].section}, ${records[0].location})`,
      };
    }

    if (failed.length) {
      return {
        status: 'couldnt_check',
        reason: failed[0].reason,
        records: [],
        source_url: failed[0].url,
        excerpt: `${failed.length} of ${LISTS.length} member lists could not be read: ` +
          failed.map((f) => `${f.section}: ${f.reason} (${f.excerpt})`).join('; '),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: OVERVIEW_URL,
      excerpt: `No exact match in ${searched} member rows of ${LISTS.length} section lists (${LISTS.map((l) => l.section).join(', ')}); Thun-Oberland publishes no list`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: OVERVIEW_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
