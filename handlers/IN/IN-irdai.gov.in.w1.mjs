export const meta = {
  task: 'IN-irdai.gov.in',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registry', 'registration_no', 'category', 'address', 'principal_officer', 'phone', 'contact', 'valid', 'source_url'],
  canary: { found: 'HDFC Life Insurance Company Limited', not_found: 'अनजान बीमा कंपनी लिमिटेड' },
};

const BASE = 'https://irdai.gov.in';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The IRDAI registry pages. Each one is a static HTML table that lists every entry on the page.
// Column numbers are 0-based and were read from the live pages; headerRe guards against a layout change.
const REGISTRIES = [
  { registry: 'life insurer', path: 'list-of-life-insurers1', table: 'lifeinsurers', headerRe: /name/i,
    nameCol: 1, regCol: 2, addrCol: 3, officerCol: 4, phoneCol: 8, contactCols: [9] },
  { registry: 'general insurer', path: 'list-of-general-insurers', table: 'nonlifeinsurers', headerRe: /insurer/i,
    nameCol: 1, addrCol: 2, officerCol: 3, phoneCol: 5, contactCols: [6] },
  { registry: 'health insurer', path: 'list-of-health-insurers', table: 'healthl', headerRe: /insurer/i,
    nameCol: 1, addrCol: 2, officerCol: 3, phoneCol: 5, contactCols: [6] },
  { registry: 'reinsurer', path: 'list-of-reinsurers', table: 'reinsurers', headerRe: /company/i,
    nameCol: 1, regCol: 2, officerCol: 3, addrCol: 4, phoneCol: 5, contactCols: [8] },
  { registry: 'insurance broker', path: 'list-of-brokers', table: 'brokersList', headerRe: /name/i,
    nameCol: 2, regCol: 1, catCol: 5, addrCol: 3, phoneCol: 4, officerCol: 6, fromCol: 7, toCol: 8, contactCols: [9] },
  { registry: 'corporate agent', path: 'list-of-corporate-agents', table: 'agentList', headerRe: /name/i,
    nameCol: 2, regCol: 1, catCol: 3, officerCol: 4, addrCol: 5, phoneCol: 6, fromCol: 7, toCol: 8, contactCols: [] },
  { registry: 'web aggregator', path: 'list-of-web-aggregators', table: 'webaggregators', headerRe: /name/i,
    nameCol: 2, regCol: 1, addrCol: 3, officerCol: 5, validCol: 6, contactCols: [4, 7] },
];

// Words that are only a legal form, so "Limited" / "Pvt. Ltd." do not block a match. Hindi forms included.
const LEGAL = new Set(['limited', 'ltd', 'private', 'pvt', 'company', 'co', 'the', 'लिमिटेड', 'प्राइवेट', 'कंपनी', 'लि', 'प्रा']);

/** Normalised name: case, punctuation and legal-form words removed; "Ins" read as "insurance". */
function normalizeName(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t && !LEGAL.has(t))
    .map((t) => (t === 'ins' ? 'insurance' : t))
    .join(' ');
}

/** Every form a registry cell can match under: whole cell, its Latin part, its local-script part, and each '/' piece. */
function nameKeys(cell) {
  const keys = new Set();
  const add = (s) => {
    const n = normalizeName(s);
    if (n) keys.add(n);
  };
  for (const piece of [cell, ...cell.split('/')]) {
    add(piece);
    add(piece.replace(/\p{Script=Devanagari}+/gu, ' '));
    add(piece.replace(/[A-Za-z0-9]+/g, ' '));
  }
  return keys;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function cleanText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cellsOf(rowHtml) {
  return (rowHtml.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(cleanText);
}

function tableOf(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf('<table', at);
  const end = html.indexOf('</table>', at);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end);
}

function fail(reg, url, reason, excerpt) {
  return { reg, url, fail: { reason, excerpt: String(excerpt).slice(0, 300) } };
}

async function getPage(reg) {
  const url = `${BASE}/${reg.path}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail(reg, url, 'blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail(reg, url, 'http_error', `HTTP ${res.status}`);
    const html = await res.text();

    const table = tableOf(html, reg.table);
    if (!table) {
      const blocked = /captcha|access denied|are you a robot/i.test(html);
      return fail(reg, url, blocked ? 'blocked' : 'layout_changed', `no table id="${reg.table}" on the page`);
    }
    const thead = (table.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0];
    const tbody = (table.match(/<tbody[\s\S]*?<\/tbody>/i) || [''])[0];
    const head = cellsOf((thead.match(/<tr[\s\S]*?<\/tr>/i) || [''])[0]);
    if (!reg.headerRe.test(head[reg.nameCol] || '')) {
      return fail(reg, url, 'layout_changed', `column ${reg.nameCol} is "${head[reg.nameCol] || ''}", not a name column`);
    }
    const rows = (tbody.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((r) => (r.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText));
    return { reg, url, rows };
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return fail(reg, url, timeout ? 'timeout' : 'other', String(e?.message || e));
  }
}

function recordOf(reg, cells, url) {
  const g = (i) => (i === undefined ? '' : cells[i] || '');
  let valid = '';
  if (reg.validCol !== undefined) valid = g(reg.validCol);
  else if (reg.fromCol !== undefined) valid = [g(reg.fromCol), g(reg.toCol)].filter(Boolean).join(' to ');
  return {
    name: g(reg.nameCol),
    registry: reg.registry,
    registration_no: g(reg.regCol),
    category: g(reg.catCol),
    address: g(reg.addrCol),
    principal_officer: g(reg.officerCol),
    phone: g(reg.phoneCol),
    contact: reg.contactCols.map(g).filter(Boolean).join(' | '),
    valid,
    source_url: url,
  };
}

/** Look one company up across the IRDAI registry tables. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pages = REGISTRIES.map((r) => `${BASE}/${r.path}`);
  try {
    const input = String(keyword ?? '').trim();
    const want = normalizeName(input);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pages.join(' | '), excerpt: 'the company name is empty after normalising' };
    }

    const checked = await Promise.all(REGISTRIES.map(getPage));
    const records = [];
    for (const page of checked) {
      if (page.fail) continue;
      for (const cells of page.rows) {
        const cell = cells[page.reg.nameCol];
        if (!cell || !nameKeys(cell).has(want)) continue;
        records.push(recordOf(page.reg, cells, page.url));
      }
    }

    if (records.length) {
      const urls = [...new Set(records.map((r) => r.source_url))];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: urls.join(' | '),
        excerpt: records.map((r) => `${r.name} (${r.registry}, ${r.registration_no || 'no reg. no.'})`).join('; ').slice(0, 500),
      };
    }

    const failed = checked.filter((p) => p.fail);
    if (failed.length) {
      // Not every registry could be read, so an empty result here does not prove the company is absent.
      const first = failed[0];
      return {
        status: 'couldnt_check',
        reason: first.fail.reason,
        records: [],
        source_url: first.url,
        excerpt: `${failed.length} of ${checked.length} registry pages could not be read: ${failed.map((p) => `${p.reg.registry} (${p.fail.reason}: ${p.fail.excerpt})`).join('; ')}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pages.join(' | '),
      excerpt: `no row matched "${input}" in ${checked.length} IRDAI registry tables (life, general, health, reinsurers, brokers, corporate agents, web aggregators)`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: pages.join(' | '),
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
