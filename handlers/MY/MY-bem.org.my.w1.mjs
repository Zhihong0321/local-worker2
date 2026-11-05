export const meta = {
  task: 'MY-bem.org.my',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'type', 'registrationNo', 'branch', 'status', 'state', 'phone', 'address'],
  canary: { found: '3D CONSULTANTS (SARAWAK) SDN BHD', not_found: 'Dezeno' },
};

/*
 * BEM's public Engineering Consultancy Practice (ECP) directory.
 * bem.org.my itself publishes no per-company list: its homepage
 * ("BEM Registration Statistics" -> ENGINEERING CONSULTANCY PRACTICES -> "View Directory")
 * links to this BEM-run directory, which answers a company name with one plain GET:
 *   https://engineer.org.my/public/ECPs/Directory?name=<name>
 * The HTML result table (#geapplicationtable) is rendered server side; no JS, no cookie,
 * no POST, no login. Paging is the same URL plus &pageNumber=N (20 rows per page).
 */

const BASE = 'https://engineer.org.my/public/ECPs/Directory';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_PAGES = 5;
const PAGE_GAP_MS = 1000;

const MARKER_TABLE = 'id="geapplicationtable"';
const MARKER_HEAD = '<th>Name</th>';
const MARKER_TITLE = 'Directory of Engineering Consultancy Practices';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function blocked(body, status) {
  if (status === 401 || status === 403 || status === 429 || status === 503) return true;
  return /<title>\s*Just a moment/i.test(body) || /cf-chl-|__cf_chl_|turnstile/i.test(body);
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-MY,en;q=0.9',
      },
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the result table rows of one page. Returns null when the expected markup is gone. */
function parseRows(body) {
  const tableAt = body.indexOf(MARKER_TABLE);
  if (tableAt === -1) return null;
  const tbodyAt = body.indexOf('<tbody', tableAt);
  if (tbodyAt === -1) return null;
  const endAt = body.indexOf('</tbody>', tbodyAt);
  if (endAt === -1) return null;
  const chunk = body.slice(tbodyAt, endAt);

  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(chunk)) !== null) {
    const rowHtml = m[1];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const raw = [];
    let c;
    while ((c = cellRe.exec(rowHtml)) !== null) raw.push(c[1]);
    if (raw.length < 9) continue; // No | Type | Name | Email | Phone | RegNo | Branch | Status | Address | State
    const span = raw[2].match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    const name = stripTags(span ? span[1] : raw[2]).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    rows.push({
      name,
      type: stripTags(raw[1]).replace(/\s+/g, ' ').trim(),
      phone: stripTags(raw[4]).replace(/\s+/g, ' ').trim(),
      registrationNo: stripTags(raw[5]).replace(/\s+/g, ' ').trim(),
      branch: stripTags(raw[6]).replace(/\s+/g, ' ').trim(),
      status: stripTags(raw[7]).replace(/\s+/g, ' ').trim(),
      address: stripTags(raw[8]).trim(),
      state: stripTags(raw[9] || '').replace(/\s+/g, ' ').trim(),
    });
  }
  return { rows, hasNext: /name="pageNumber"\s+value="/.test(body) };
}

function excerptFor(rows) {
  if (!rows.length) return '';
  const text = rows
    .slice(0, 3)
    .map(
      (r) =>
        `${r.name} [${r.type}; Reg No ${r.registrationNo}; ${r.branch}; ${r.status}; ${r.state}; tel ${r.phone}]`
    )
    .join(' || ');
  return text.length > 500 ? text.slice(0, 497) + '...' : text;
}

/**
 * Look one company up. Must never throw.
 */
export default async function lookup(keyword) {
  const name = String(keyword == null ? '' : keyword).trim();
  const url1 = `${BASE}?name=${encodeURIComponent(name)}`;
  if (!name) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: 'empty company name passed to lookup',
    };
  }

  try {
    const seen = [];
    const seenNames = new Set();
    let sourceUrl = url1;
    let page = 1;
    let lastBody = '';

    while (page <= MAX_PAGES) {
      const url =
        page === 1 ? url1 : `${url1}&pageNumber=${page}`;
      const { status, body } = await fetchPage(url);
      lastBody = body;

      if (blocked(body, status)) {
        return {
          status: 'couldnt_check',
          reason: 'blocked',
          records: [],
          source_url: url,
          excerpt: (body.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].slice(0, 300),
        };
      }
      if (status === 404 || status >= 500) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${status}` };
      }
      if (status !== 200) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${status}` };
      }
      if (
        !body.includes(MARKER_TABLE) ||
        !body.includes(MARKER_HEAD) ||
        !body.includes(MARKER_TITLE)
      ) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: url,
          excerpt: (body.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].slice(0, 300),
        };
      }

      const parsed = parseRows(body);
      if (!parsed) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: url,
          excerpt: 'result table #geapplicationtable has no <tbody> anymore',
        };
      }

      for (const r of parsed.rows) {
        const key = `${r.name}|${r.registrationNo}`;
        if (!seenNames.has(key)) {
          seenNames.add(key);
          seen.push(r);
        }
      }
      if (page === 1 && parsed.rows.length) sourceUrl = url;

      const nextExists = new RegExp(`name="pageNumber"\\s+value="${page + 1}"`).test(body);
      if (!parsed.hasNext || !nextExists || parsed.rows.length === 0) break;
      page += 1;
      await sleep(PAGE_GAP_MS);
    }

    if (seen.length === 0) {
      const head = lastBody.indexOf(MARKER_TABLE);
      const tableText = stripTags(lastBody.slice(head, head + 900)).replace(/\s+/g, ' ').trim();
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url1,
        excerpt: (tableText || 'empty result table').slice(0, 500),
      };
    }

    return {
      status: 'found',
      reason: '',
      records: seen,
      source_url: sourceUrl,
      excerpt: excerptFor(seen),
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    const reason = /abort|timeout/i.test(msg) ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: url1, excerpt: msg.slice(0, 300) };
  }
}
