export const meta = {
  task: 'IE-pleanala.ie',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'case_ref', 'case_url', 'status', 'case_type', 'date_lodged', 'description', 'parties'],
  canary: { found: 'Amazon MCS Ireland Limited', not_found: 'Comhlacht Neamhliostaithe Teoranta' },
};

const BASE = 'https://www.pleanala.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped from the END of a company name before comparing.
const LEGAL_WORDS = ['limited', 'ltd', 'teoranta', 'teo', 'dac', 'plc', 'unlimited', 'uc', 'cuideachta', 'company',
  'co', 'inc', 'llc', 'sdn', 'bhd', 'pte', 'gmbh', 'designated', 'activity', 'cpt'];

function stripDiacritics(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Lower-case, no punctuation, single spaces, no trailing legal form. */
function normalizeName(s) {
  let words = stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_WORDS.includes(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The keyword as typed, with a trailing legal form removed, used as the site search text. */
function searchText(keyword) {
  let s = (keyword || '').trim();
  const legal = /[\s,.]+(?:limited|ltd|teoranta|teo|dac|plc|unlimited|uc|cuideachta|company|co|inc|llc|sdn\s+bhd|bhd|pte\s+ltd|pte|gmbh|designated\s+activity\s+company|cpt)\.?\s*$/i;
  let prev;
  do {
    prev = s;
    s = s.replace(legal, '').trim();
  } while (s !== prev && s.length > 0);
  return s || (keyword || '').trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] ?? m));
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function field(block, label) {
  const m = block.match(new RegExp(`<em>${label}:?<\\/em>([\\s\\S]*?)<\\/span>`, 'i'));
  return m ? cleanText(m[1]) : '';
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const query = searchText(keyword);
  const sourceUrl = `${BASE}/en-ie/cases?parties=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(sourceUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', sourceUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', sourceUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|cf-chl|challenge-platform|access denied/i.test(html)) return fail('blocked', sourceUrl, 'bot check page');

    const noCases = html.includes('No cases found');
    const countMatch = html.match(/Displaying:\s*(\d+)\s*cases?/i);
    if (!noCases && !countMatch) return fail('layout_changed', sourceUrl, html.slice(0, 300));

    if (noCases && !countMatch) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `No cases found with "${query}" as a party`,
      };
    }

    const total = parseInt(countMatch[1], 10);
    // Case ids are not always digits (e.g. PC..., TC..., CH...), so accept any id made of letters, digits, - and _.
    const cards = [...html.matchAll(/<a href="\/en-ie\/case\/([A-Za-z0-9_-]+)" class="card-item[^"]*card-item--case[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
    if (cards.length !== total) return fail('layout_changed', sourceUrl, `page says ${total} cases, parsed ${cards.length}`);

    const want = normalizeName(keyword);
    if (!want) return fail('other', sourceUrl, 'empty company name');

    const records = [];
    for (const [, caseId, body] of cards) {
      const parties = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => cleanText(m[1]));
      const matched = parties.filter((p) => {
        const noStatus = p.replace(/\s*\((?:Active|Inactive)\)\s*$/i, '').trim();
        const noAlias = noStatus.replace(/\s*\([^()]*\)\s*$/, '').trim();
        return normalizeName(noStatus) === want || normalizeName(noAlias) === want;
      });
      if (matched.length === 0) continue;
      const metaMatch = body.match(/<span class="meta">([\s\S]*?)<\/span>/);
      records.push({
        name: matched[0].replace(/\s*\((?:Active|Inactive)\)\s*$/i, '').trim(),
        case_ref: caseId,
        case_url: `${BASE}/en-ie/case/${caseId}`,
        status: field(body, 'Status'),
        case_type: metaMatch ? cleanText(metaMatch[1]) : '',
        date_lodged: field(body, 'Date lodged'),
        description: field(body, 'Description'),
        parties,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `${total} case(s) returned for "${query}"; none lists this company as a party`,
      };
    }
    return {
      status: 'found', reason: '', records, source_url: sourceUrl,
      excerpt: `${records.length} case(s) list "${records[0].name}" as a party; first: ${records[0].case_ref} (${records[0].status})`,
    };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return fail(reason, sourceUrl, String(err?.message || err));
  }
}
