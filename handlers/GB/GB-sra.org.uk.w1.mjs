export const meta = {
  task: 'GB-sra.org.uk',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'sra_number', 'status', 'head_office', 'type_of_firm', 'regulator', 'company_registration',
    'regulatory_record', 'website', 'also_known_as'],
  canary: { found: 'Ashurst Perkins Coie (International) LLP', not_found: 'Qwrtzkl Bramhope Vexmoor' },
};

const BASE = 'https://www.sra.org.uk/consumers/register/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ROWS = 50;
const LEGAL_FORMS = ['llp', 'ltd', 'limited', 'plc', 'lp', 'llc'];

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case word tokens, accents removed, legal-form suffix removed (LLP, Ltd, ...). */
function coreKey(name) {
  const toks = decode(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  while (toks.length > 1 && LEGAL_FORMS.includes(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

/** The search text: the company name as typed, minus a trailing legal form. */
function searchText(keyword) {
  const words = decode(keyword).trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.includes(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) words.pop();
  return words.join(' ');
}

function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function errReason(err) {
  const n = String(err?.name || '');
  return (n === 'TimeoutError' || n === 'AbortError') ? 'timeout' : 'other';
}

/** One search-result row: sra number, name, status, head office, also known as. */
function parseRows(html) {
  const rows = [];
  const re = /<li tabindex="0" id="firm-row-id-\d+">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const sra = (body.match(/goToOrgDetails\((\d+)\)/) || [])[1] || '';
    if (!sra) continue;
    const name = clean((body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
    const status = clean((body.match(/label__sm__block__icon[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    const location = clean((body.match(/label__sm__block__location">([\s\S]*?)<\/p>/) || [])[1])
      .replace(/^Head office\s*(in\s*)?/i, '');
    const aka = clean((body.match(/Also known as([\s\S]*?)<\/p>/i) || [])[1]);
    rows.push({ sra_number: sra, name, status, head_office: location, also_known_as: aka });
  }
  return rows;
}

function field(html, label) {
  const re = new RegExp('<dt[^>]*>\\s*<strong>\\s*' + label + '\\s*</strong>\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>', 'i');
  const m = html.match(re);
  return m ? clean(m[1]).replace(/View contact details/i, '').trim() : '';
}

/** The firm detail page for one SRA number. Adds the regulatory record and firm facts. */
async function detail(row, q) {
  const url = `${BASE}organisation/?sraNumber=${encodeURIComponent(row.sra_number)}` +
    `&prevSearchText=${encodeURIComponent(q)}&prevSearchFilter=Firm`;
  const res = await get(url);
  if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
  const html = await res.text();
  const name = clean((html.match(/<h1 class="reg__detail__h1">([\s\S]*?)<\/h1>/) || [])[1]) || row.name;
  const status = clean((html.match(/id="LicensedBodyAuthorisedLabel">([\s\S]*?)<\/span>/) || [])[1]) || row.status;
  return {
    url,
    record: {
      name,
      sra_number: field(html, 'SRA number') || row.sra_number,
      status,
      head_office: field(html, 'Head office address') || row.head_office,
      type_of_firm: field(html, 'Type of firm'),
      regulator: field(html, 'Regulator'),
      company_registration: field(html, 'Company registration'),
      regulatory_record: field(html, 'Regulatory record'),
      website: field(html, 'Website'),
      also_known_as: row.also_known_as,
    },
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const key = coreKey(kw);
  if (!key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
  }
  const q = searchText(kw);
  const searchUrl = `${BASE}?searchText=${encodeURIComponent(q)}&searchBy=Organisation&numberOfResults=${ROWS}`;

  try {
    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429 || /mysra|login/i.test(res.url || '')) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const isResultPage = /firm-row-id-\d+|No results means that we have no record|firm results for/.test(html);
    if (!isResultPage) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: clean(html).slice(0, 300) };
    }

    const rows = parseRows(html);
    const total = Number((html.match(/of\s+(\d+)\s+firm results/) || [])[1] || rows.length);
    const matches = rows.filter((r) => coreKey(r.name) === key).slice(0, 3);

    if (matches.length === 0) {
      if (rows.length > 0 && total > rows.length) {
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `exact name not among the first ${rows.length} of ${total} results; absence not proven`,
        };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 firm records with the name "${kw}" on the SRA Solicitors Register`,
      };
    }

    // Detail pages in parallel; if one fails the search-row data is still returned.
    const details = await Promise.all(matches.map((row) =>
      detail(row, q).then((d) => d).catch((e) => ({ error: String(e?.message || e), row, reason: errReason(e) }))));
    const records = details.map((d) => (d.record ? d.record : d.row));
    const first = details[0];
    const excerpt = first.record
      ? `${first.record.name} | ${first.record.status} | ${first.record.regulatory_record}`.slice(0, 500)
      : `${matches[0].name} | ${matches[0].status} (detail page not read: ${first.error})`.slice(0, 500);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.url || searchUrl,
      excerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: errReason(err),
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
