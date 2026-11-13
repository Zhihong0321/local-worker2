export const meta = {
  task: 'FR-conseil-etat.fr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['decision_id', 'court', 'jurisdiction', 'collection', 'reference', 'ecli', 'date', 'outcome', 'subject', 'match', 'matched_text'],
  canary: { found: 'Société Générale', not_found: 'Société Zorblaxe Imaginaire' },
};

const SEARCH_URL = 'https://www.conseil-etat.fr/xsearch?type=json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SOURCES = ['AW_DCE', 'AW_AJCE', 'AW_CRP', 'AW_DTC', 'AW_AJTC', 'AW_DCA', 'AW_AJCA', 'PCJA', 'AW_PCJA_FS'];
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const DEADLINE_MS = 40000;
// Legal-form words stripped from the start and end of a name before comparing.
const LEGAL_FORMS = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sarlu', 'snc', 'sci', 'sca', 'scs', 'scop', 'selarl', 'selas', 'gie', 'sprl', 'bv', 'srl', 'spa', 'ltd', 'gmbh', 'inc', 'llc', 'plc']);

/** Lower case, no accents, no punctuation, single spaces. */
function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Folded name with legal-form words removed from both ends (never empties the name). */
function coreName(s) {
  const t = fold(s).split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  while (t.length > 1 && LEGAL_FORMS.has(t[0])) t.shift();
  return t.join(' ');
}

/** Turns the site's highlight markup ({b} {nb} {/b}) into plain text. */
function stripMarkup(s) {
  return (s || '').replace(/\{\/?(b|nb)\}/g, '').replace(/\s+/g, ' ').trim();
}

function bodyFor(keyword, skip) {
  const phrase = coreName(keyword);
  const params = new URLSearchParams();
  params.append('advanced', '1');
  params.append('type', 'json');
  for (const s of SOURCES) params.append('SourceStr4', s);
  params.append('text.add', `"${phrase}"`);
  params.append('synonyms', 'true');
  params.append('scmode', 'smart');
  params.append('SkipCount', String(PAGE_SIZE));
  params.append('SkipFrom', String(skip));
  return params.toString();
}

/** Does this result really name the company? Either the site tagged it or the name sits in the text as a whole phrase. */
function matchDoc(doc, name) {
  const parts = (doc.Company || '').split(';');
  if (parts.some((p) => fold(p) === name)) return 'company_tag';
  const text = ` ${fold(stripMarkup(doc.Extracts))} `;
  if (name && text.includes(` ${name} `)) return 'name_in_text';
  return null;
}

function snippetAround(doc, name) {
  const plain = stripMarkup(doc.Extracts || '');
  const at = fold(plain).indexOf(name);
  if (at < 0) return plain.slice(0, 300);
  const start = Math.max(0, at - 120);
  return plain.slice(start, start + 300);
}

function toRecord(doc, how, name) {
  return {
    decision_id: doc.Id || '',
    court: doc.Title || '',
    jurisdiction: doc.SourceStr3 || '',
    collection: doc.SourceStr4 || '',
    reference: doc.SourceStr5 || doc.SourceCsv1 || '',
    ecli: doc.SourceStr30 || '',
    date: (doc.SourceDateTime1 || '').split(' ')[0],
    outcome: doc.SourceStr12 || '',
    subject: doc.SourceStr21 || '',
    match: how,
    matched_text: how === 'name_in_text' ? snippetAround(doc, name) : '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = coreName(keyword);
  if (!name) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_URL, excerpt: 'empty company name' };
  }
  try {
    const records = [];
    const seen = new Set();
    let total = null;
    let scanned = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - started > DEADLINE_MS) break;
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyFor(keyword, page * PAGE_SIZE),
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const low = text.toLowerCase();
        const reason = low.includes('captcha') || low.includes('access denied') ? 'blocked' : 'layout_changed';
        return { status: 'couldnt_check', reason, records: [], source_url: SEARCH_URL, excerpt: text.slice(0, 300) };
      }
      if (!data || typeof data.TotalCount !== 'number' || !Array.isArray(data.Documents)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_URL, excerpt: text.slice(0, 300) };
      }

      if (page === 0) {
        total = data.TotalCount;
        if (total === 0) {
          return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL, excerpt: `0 results for "${coreName(keyword)}"` };
        }
      }

      scanned += data.Documents.length;
      for (const doc of data.Documents) {
        const how = matchDoc(doc, name);
        if (how && !seen.has(doc.Id)) {
          seen.add(doc.Id);
          records.push(toRecord(doc, how, name));
        }
      }

      if (data.Documents.length < PAGE_SIZE || scanned >= total) break;
      if (records.length > 0) break;
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: SEARCH_URL,
        excerpt: `${records.length} decision(s) name "${name}" (of ${total} phrase hits, first ${scanned} read)`,
      };
    }

    if (scanned >= total) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `${total} phrase hit(s) for "${name}", none names the company`,
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SEARCH_URL,
      excerpt: `${total} phrase hits for "${name}"; read ${scanned} within the time limit, none named the company`,
    };
  } catch (err) {
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: aborted ? 'timeout' : 'other',
      records: [],
      source_url: SEARCH_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
