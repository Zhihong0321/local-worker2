export const meta = {
  task: 'NL-nvwa.nl',
  want: 'w1',
  tier: 2,
  method: 'other',
  pdf: false,
  input: 'company name',
  fields: ['name', 'recognition_number', 'approval_kind', 'address', 'postcode', 'city', 'status', 'start_date', 'end_date', 'activities', 'categories', 'specifications'],
  canary: { found: 'Albert Keijzer B.V.', not_found: 'Onbestaand Zuivelbedrijf Kwartel B.V.' },
};

// The public page "Zoek bedrijven met een erkenning, registratie of vergunning" embeds a search widget. The widget
// sends a SOAP request (text/xml POST, operation zoekBedrijfElement) to this endpoint, which answers in XML.
const PAGE_URL = 'https://www.nvwa.nl/onderwerpen/zaken-regelen/erkenningen-registraties-en-vergunningen/overzicht-bedrijven-met-erkenningen-registraties-en-vergunningen';
const ENDPOINT = 'https://e-certnl.nvwa.nl/VINDBAARHEID_EBF-Berichtenboek-context-root/Berichtenboek';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 8;
const TIME_BUDGET_MS = 40000;
const LEGAL_FORMS = new Set(['bv', 'nv', 'vof', 'cv', 'commv', 'bvba', 'maatschap', 'eenmanszaak', 'stichting', 'coop', 'cooperatie']);

/** Lower-case, no accents, no punctuation, no legal form: "Albert Keijzer B.V." -> "albert keijzer". */
function core(s) {
  const t = String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' en ').replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_FORMS.has(w)).join(' ');
}

/** Normalised name with spaces removed, used for the exact comparison. */
function squash(s) {
  return core(s).replace(/ /g, '');
}

/** The search text: the user's words without the legal-form words ("Albert Keijzer B.V." -> "Albert Keijzer"). */
function searchTerm(keyword) {
  return String(keyword || '').trim().split(/\s+/).filter((w) => core(w) !== '').join(' ');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function envelope(term, offset) {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:WL5G3N1="http://nl/minlnv/cvg/Berichtenboek.wsdl/types/" xmlns:WL5G3N2="http://nl/minlnv/cvg/Berichtenboek.wsdl" xmlns:tns="http://nl/minlnv/cvg/Berichtenboek.wsdl/types/" xmlns:tns0="http://nl/minlnv/cvg/Berichtenboek.wsdl/types/">
<soap:Header></soap:Header>
<soap:Body>
<WL5G3N1:zoekBedrijfElement>
<WL5G3N1:iZoekCriteria>
  <WL5G3N1:erkenningsnummer></WL5G3N1:erkenningsnummer>
  <WL5G3N1:handelsnaam>${esc(term)}</WL5G3N1:handelsnaam>
  <WL5G3N1:postcode></WL5G3N1:postcode>
  <WL5G3N1:productGroup></WL5G3N1:productGroup>
  <WL5G3N1:categorieen></WL5G3N1:categorieen>
  <WL5G3N1:diersoorten></WL5G3N1:diersoorten>
  <WL5G3N1:activiteiten></WL5G3N1:activiteiten>
  <WL5G3N1:producten></WL5G3N1:producten>
  <WL5G3N1:taal>NL</WL5G3N1:taal>
  <WL5G3N1:exportland></WL5G3N1:exportland>
  <WL5G3N1:pagination><WL5G3N1:cvgOffset>${offset}</WL5G3N1:cvgOffset></WL5G3N1:pagination>
</WL5G3N1:iZoekCriteria>
</WL5G3N1:zoekBedrijfElement>
</soap:Body>
</soap:Envelope>`;
}

function decode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').trim();
}

// One XML element with text or a nil marker: <m:name>text</m:name>, <m:name xsi:nil="true"/>
const ELEMENT = /<(?:[\w.-]+:)?(\w+)(\s[^>]*)?(?:\/>|>([^<]*)<\/(?:[\w.-]+:)?\1>)/g;

function fieldsOf(block) {
  const out = {};
  for (const m of block.matchAll(ELEMENT)) {
    out[m[1]] = m[0].endsWith('/>') ? null : decode(m[3] ?? '');
  }
  return out;
}

function num(v) {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Returns null when the answer is not the expected search response. */
function parseSearch(xml) {
  if (!/zoekBedrijfResponseElement/.test(xml)) return null;
  const pagination = (xml.match(/<(?:[\w.-]+:)?pagination(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?pagination>/) || [])[1] || '';
  const p = fieldsOf(pagination);
  const section = (xml.match(/<(?:[\w.-]+:)?erkendebedrijven(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?erkendebedrijven>/) || [])[1] || '';
  const rows = [];
  for (const m of section.matchAll(/<(?:[\w.-]+:)?array(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?array>/g)) {
    rows.push(fieldsOf(m[1]));
  }
  // cvgTotal counts approvals (one per erkenningsnummer); each approval can have several rows (specifications).
  return { total: num(p.cvgTotal), returned: num(p.cvgReturned), limit: num(p.cvgLimit) || 20, rows };
}

/** dd-MM-yyyy -> Date, or null. */
function parseNlDate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || '').trim());
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

/** 'active' with no end date or an end date still ahead, 'ended' when the end date has passed, else 'unknown'. */
function rowStatus(r) {
  if (!r.opheffingsdatum) return 'active';
  const end = parseNlDate(r.opheffingsdatum);
  if (!end) return 'unknown';
  return end.getTime() >= Date.now() ? 'active' : 'ended';
}

const RANK = { active: 3, unknown: 2, ended: 1 };

/** Groups the rows whose trade name matches the wanted name, one record per approval number. */
function groupMatches(rows, wanted) {
  const byNr = new Map();
  for (const r of rows) {
    if (!r.handelsnaam || squash(r.handelsnaam) !== wanted) continue;
    const nr = r.erkenningsnummer || '';
    if (!byNr.has(nr)) {
      byNr.set(nr, {
        name: r.handelsnaam, recognition_number: nr, approval_kind: r.erkenningssoort || '',
        address: r.adres || '', postcode: r.postcode || '', city: r.plaats || '',
        status: 'ended', start_date: r.aanvangsdatum || '', end_date: '',
        activities: new Set(), categories: new Set(), specifications: [], open: false,
      });
    }
    const rec = byNr.get(nr);
    const st = rowStatus(r);
    if (RANK[st] > RANK[rec.status]) rec.status = st;
    if (!r.opheffingsdatum) rec.open = true;
    else if (!rec.end_date || (parseNlDate(r.opheffingsdatum) > parseNlDate(rec.end_date))) rec.end_date = r.opheffingsdatum;
    if (r.activiteit) rec.activities.add(r.activiteit);
    if (r.categorie) rec.categories.add(r.categorie);
    rec.specifications.push({
      code: r.specificatiecode || '', activity: r.activiteit || '', category: r.categorie || '',
      product_type: r.producttype || '', description: r.bijzonderheden || '',
    });
  }
  return [...byNr.values()].map(({ open, ...rec }) => ({
    ...rec,
    end_date: open ? '' : rec.end_date,
    activities: [...rec.activities],
    categories: [...rec.categories],
  }));
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const term = searchTerm(keyword);
    const wanted = squash(keyword);
    if (!term || !wanted) return couldnt('other', 'the name is empty once the legal form is removed');

    const rows = [];
    let total = 0;
    let offset = 0;
    let pages = 0;
    let truncated = false;
    for (;;) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'text/xml; charset=utf-8',
          'Accept': 'text/xml, application/xml;q=0.9, */*;q=0.8',
        },
        body: envelope(term, offset),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

      const parsed = parseSearch(await res.text());
      if (!parsed) return couldnt('layout_changed', 'the answer is not the expected search response');
      pages += 1;
      total = parsed.total;
      rows.push(...parsed.rows);
      offset += parsed.limit;
      if (parsed.returned === 0 || offset >= total) break;
      if (pages >= MAX_PAGES || Date.now() - started > TIME_BUDGET_MS) { truncated = true; break; }
    }

    const records = groupMatches(rows, wanted);
    const readNote = truncated ? ` (only the first ${Math.min(offset, total)} of ${total} results were read)` : '';
    const sourceNote = `search "${term}" on the NVWA register`;

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: PAGE_URL,
        excerpt: `${records.length} approval(s) for "${records[0].name}"; ${sourceNote}, ${total} results${readNote}`,
      };
    }
    if (truncated) return couldnt('other', `no exact match in the results read; ${sourceNote}${readNote}`);

    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL, excerpt: `${sourceNote} returned 0 results` };
    }
    const similar = [...new Set(rows.map((r) => r.handelsnaam).filter(Boolean))].slice(0, 5);
    return {
      status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
      excerpt: `${sourceNote} returned ${total} approval(s), none with this exact name. Similar: ${similar.join('; ')}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', String((err && err.message) || err));
  }
}
