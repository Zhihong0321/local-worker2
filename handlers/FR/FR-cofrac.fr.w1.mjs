export const meta = {
  task: 'FR-cofrac.fr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entity_id', 'address', 'phone', 'type', 'sector', 'dossiers', 'accreditation_states'],
  canary: { found: 'BUREAU VERITAS CERTIFICATION FRANCE', not_found: 'SOCIETE INEXISTANTE ZOXYQUA SAS' },
};

const SEARCH_URL = 'https://tools.cofrac.fr/fr/easysearch/index.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 30;     // the site shows 30 results per page
const MAX_PAGES = 5;      // at most 150 results read
const LEGAL_FORMS = new Set(['SAS', 'SASU', 'SARL', 'SARLU', 'EURL', 'SA', 'SCI', 'SNC', 'SCOP', 'SCA', 'SELARL', 'SELAS', 'SEL', 'SE', 'SCM', 'SCP', 'GIE', 'SEM']);

/** Upper-case, no accents, only A-Z 0-9 separated by single spaces. */
function foldName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** Drop trailing legal-form words, e.g. "ACME TRADING SAS" -> "ACME TRADING". */
function stripLegalForm(folded) {
  const t = folded.split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** The text sent to the site: the name without punctuation and without a trailing legal form. */
function searchTerm(keyword) {
  const words = String(keyword || '').replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(foldName(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] ?? m));
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function formBody(term, page) {
  const p = new URLSearchParams();
  p.set('easykeywords', term);
  p.set('selsearch', 'NOM');          // "par nom"
  p.set('porteefilter', '1');         // the site's default scope
  p.set('currentPage', String(page));
  p.set('counts', '');
  p.set('selsearch0', 'NOM');
  p.set('easykeywords0', term);
  p.set('activite', '');
  p.set('selby', '');
  return p.toString();
}

/** Parse one results page into entity records (one per entity block on the page). */
function parseEntities(html) {
  const startIdx = html.search(/id=["']?resultats-easysearch/);
  if (startIdx < 0) return [];
  let region = html.slice(startIdx);
  const alertIdx = region.search(/<div id=["']?alert/);
  if (alertIdx > 0) region = region.slice(0, alertIdx);

  const starts = [...region.matchAll(/<div class=["']?entite["']?\s+id=["']?enti_(\d+)["']?>/g)];
  const out = [];
  starts.forEach((m, i) => {
    const block = region.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : region.length);
    const nameMatch = block.match(/<b>([\s\S]*?)<\/b>/);
    if (!nameMatch) return;
    const name = cleanText(nameMatch[1]);

    // The header (name, address, phone, type, sector) ends at the first </div> after "Secteur :".
    const secIdx = block.search(/Secteur\s*:/);
    const headEnd = secIdx >= 0 ? block.indexOf('</div>', secIdx) : -1;
    const header = headEnd > 0 ? block.slice(0, headEnd) : block.slice(0, 1000);
    const afterName = header.slice(header.indexOf('</b>') + 4);
    const lines = afterName.split(/<br\s*\/?>/i).map(cleanText).filter(Boolean);
    const phoneLine = lines.find((l) => /^T[ée]l/i.test(l)) || '';
    const addressLine = lines.find((l) => !/^T[ée]l/i.test(l) && !/^Type\s*:/i.test(l)) || '';
    const typeMatch = header.match(/Type\s*:\s*<font[^>]*>\s*<b>([\s\S]*?)<\/b>/i);
    const sectorMatch = header.match(/Secteur\s*:\s*<font[^>]*>\s*<b>([\s\S]*?)<\/b>/i);

    const dossiers = [...new Set([...block.matchAll(/Dossier\s*:\s*([^<\s]+)/g)].map((x) => cleanText(x[1])))];
    const states = [...new Set([...block.matchAll(/<b>\s*Etat\s*<\/b>\s*:\s*([^<]+)/gi)].map((x) => cleanText(x[1])))];

    out.push({
      name,
      entity_id: m[1],
      address: addressLine.replace(/\s*\|\s*$/, ''),
      phone: phoneLine.replace(/^T[ée]l\.?\s*:\s*/i, '').replace(/\s*\|\s*Fax.*$/i, '').trim(),
      type: typeMatch ? cleanText(typeMatch[1]) : '',
      sector: sectorMatch ? cleanText(sectorMatch[1]) : '',
      dossiers,
      accreditation_states: states,
    });
  });
  return out;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const term = searchTerm(keyword);
    if (!term) return fail('other', SEARCH_URL, 'empty company name');
    const target = stripLegalForm(foldName(keyword));
    if (!target) return fail('other', SEARCH_URL, 'no usable name in the input');

    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': SEARCH_URL,
    };

    const matches = [];
    let total = null;
    let read = 0;
    let firstExcerpt = '';

    for (let page = 0; page < MAX_PAGES; page++) {
      // Later pages only while there is time left under the 60 s limit.
      if (page > 0 && (Date.now() - started > 20000 || read >= total)) break;

      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers,
        body: formBody(term, page),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', SEARCH_URL, `HTTP ${res.status}`);

      const html = await res.text();
      const totalMatch = html.match(/<b>\s*(\d+)\s*<\/b>\s*r[ée]sultat\(s\)\s+au\s+total/i);
      if (!totalMatch) {
        if (/captcha|access denied|cloudflare|just a moment/i.test(html)) return fail('blocked', SEARCH_URL, cleanText(html).slice(0, 300));
        return fail('layout_changed', SEARCH_URL, cleanText(html).slice(0, 300));
      }
      total = parseInt(totalMatch[1], 10);
      if (total === 0) return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL, excerpt: `Search by name "${term}": 0 results` };

      const entities = parseEntities(html);
      if (entities.length === 0) return fail('layout_changed', SEARCH_URL, `${total} results reported but no entries found`);
      if (page === 0) firstExcerpt = `Search by name "${term}": ${total} results`;
      read += entities.length;
      for (const e of entities) {
        if (stripLegalForm(foldName(e.name)) === target) matches.push(e);
      }
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: SEARCH_URL,
        excerpt: `${firstExcerpt}; matched ${matches.length} entity block(s). ${cleanText(matches[0].name)} | ${matches[0].address} | ${matches[0].sector}`.slice(0, 500),
      };
    }

    if (read < total) {
      return fail('other', SEARCH_URL, `${total} results for "${term}", only the first ${read} were read, none matched exactly`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL, excerpt: `${firstExcerpt}; no entry with this exact name` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SEARCH_URL, String((err && err.message) || err));
  }
}
