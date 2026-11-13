export const meta = { task: 'DE-vda.de', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'membership_group', 'homepage'],
  canary: { found: 'Volkswagen AG', not_found: 'Nichtgelistete Musterfirma GmbH' } };

// The VDA member lists are public, server-rendered pages. Each one carries its member entries as JSON:
// {"group":"...","company":"...","homepage":"..."}. We read the five member lists and compare names.
const LISTS = [
  { url: 'https://www.vda.de/de/mitglieder/unsere-mitglieder/herstellergruppe-i', group: 'Herstellergruppe I: Automobilhersteller' },
  { url: 'https://www.vda.de/de/mitglieder/unsere-mitglieder/herstellergruppe-ii', group: 'Herstellergruppe II: Anhaenger, Aufbauten, Busse' },
  { url: 'https://www.vda.de/de/mitglieder/unsere-mitglieder/herstellergruppe-iii', group: 'Herstellergruppe III: Kfz-Zulieferer' },
  { url: 'https://www.vda.de/de/mitglieder/unsere-mitglieder/ausserordentliche-mitglieder', group: 'Ausserordentliche Mitglieder' },
  { url: 'https://www.vda.de/de/mitglieder/unsere-mitglieder/koerperschaftliche-mitglieder', group: 'Koerperschaftliche Mitglieder' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ENTRY = /\{"group":"(?:[^"\\]|\\.)*","company":"(?:[^"\\]|\\.)*"(?:,"homepage":"(?:[^"\\]|\\.)*")?\}/g;
// Legal forms and connecting words that do not change which company is meant.
const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'se', 'kg', 'co', 'ohg', 'ug', 'kgaa', 'ltd', 'bv', 'inc', 'llc', 'plc', 'sa', 'sas', 'srl', 'spa', 'e', 'v']);

/** Lower case, punctuation and legal form removed: "Volkswagen AG" and "VOLKSWAGEN" give the same key. */
function nameKey(str) {
  const decoded = (str || '').replace(/&amp;/g, '&').replace(/&auml;/g, 'ae').replace(/&ouml;/g, 'oe').replace(/&uuml;/g, 'ue').replace(/&szlig;/g, 'ss');
  const tokens = decoded.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter((t) => t && !LEGAL.has(t));
  return tokens.join(' ');
}

function failure(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Fetch one member list. Returns { list, entries } or { list, failure }. */
async function readList(list) {
  try {
    const res = await fetch(list.url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { list, failure: failure('blocked', list.url, `HTTP ${res.status}`) };
    if (!res.ok) return { list, failure: failure('http_error', list.url, `HTTP ${res.status}`) };
    const html = await res.text();
    const entries = [];
    for (const m of html.matchAll(ENTRY)) {
      try {
        const e = JSON.parse(m[0]);
        if (e.company) entries.push({ name: e.company, group: list.group, homepage: e.homepage || '', list_url: list.url });
      } catch { /* skip an entry that does not parse */ }
    }
    if (entries.length === 0) return { list, failure: failure('layout_changed', list.url, html.slice(0, 300)) };
    return { list, entries };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { list, failure: failure(timedOut ? 'timeout' : 'other', list.url, String(err?.message || err)) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = nameKey(keyword);
    if (!wanted) return failure('other', LISTS[0].url, 'the company name has no letters after removing the legal form');

    // All five lists are read at the same time, so the whole call stays well under 60 s.
    const results = await Promise.all(LISTS.map(readList));

    const seen = new Set();
    const records = [];
    for (const r of results) {
      if (!r.entries) continue;
      for (const e of r.entries) {
        if (nameKey(e.name) !== wanted) continue;
        const id = `${e.name}|${e.group}`;
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({ name: e.name, membership_group: e.group, homepage: e.homepage });
      }
    }

    if (records.length > 0) {
      const first = results.find((r) => r.entries && r.entries.some((e) => nameKey(e.name) === wanted));
      return {
        status: 'found', reason: '', records,
        source_url: first ? first.list.url : LISTS[0].url,
        excerpt: `${records.length} match(es) on the VDA member lists: ${records.map((x) => x.name).join('; ')}`.slice(0, 500),
      };
    }

    // No match: only a clean not_found when every list was read. A list that could not be read is never "not listed".
    const failed = results.filter((r) => r.failure);
    if (failed.length > 0) {
      const f = failed[0].failure;
      return { ...f, excerpt: `${failed.length} of ${LISTS.length} member lists could not be read; first: ${f.excerpt}`.slice(0, 300) };
    }
    const total = results.reduce((n, r) => n + (r.entries ? r.entries.length : 0), 0);
    return {
      status: 'not_found', reason: '', records: [],
      source_url: LISTS[0].url,
      excerpt: `Not on the VDA member lists (${total} entries read from ${LISTS.length} lists)`,
    };
  } catch (err) {
    return failure('other', LISTS[0].url, String(err?.message || err));
  }
}
