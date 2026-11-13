export const meta = {
  task: 'IN-cpcb.nic.in',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'serial_no', 'list', 'details'],
  canary: { found: 'Sithapuram Power Ltd.', not_found: 'भारत कोयला अनजान लिमिटेड' },
};

// CPCB site search. The site is a literal, case-insensitive text search over its pages; a name with
// a legal form ("Limited") does not match "Ltd.", so the legal form is removed before searching.
const SEARCH = 'https://cpcb.gov.in/search.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'pvt', 'private', 'p', 'llp', 'llc', 'inc', 'co', 'corp', 'corporation', 'company', 'plc']);

const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function clean(s) {
  return decode((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The company's core name: keyword words without the legal form at the end. */
function coreOf(keyword) {
  let pieces = keyword.trim().split(/\s+/).filter(Boolean);
  if (pieces.length && /^m\/?s\.?$/i.test(pieces[0])) pieces = pieces.slice(1);
  const items = pieces
    .map((p) => ({ w: norm(p), text: p.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '') }))
    .filter((x) => x.w);
  while (items.length && (LEGAL.has(items[items.length - 1].w) || items[items.length - 1].w === 'india')) items.pop();
  return { joined: items.map((x) => x.w).join(''), term: items.map((x) => x.text).join(' ') };
}

/** Words of a record name, each with a flag for a comma right after it. */
function words(s) {
  const out = [];
  for (const piece of (s || '').replace(/[,;]/g, ' $& ').split(/\s+/)) {
    if (!piece) continue;
    const w = norm(piece);
    const comma = /[,;]/.test(piece);
    if (w) out.push({ w, comma });
    else if (comma && out.length) out[out.length - 1].comma = true;
  }
  return out;
}

/** After the core name: a comma, the end, or a legal form ("Ltd", "Pvt Ltd") must follow. "Tata Steel Plate Mill" is not "Tata Steel". */
function tailOk(T, j, comma) {
  if (comma || j === T.length) return true;
  let k = j;
  while (k < T.length && (LEGAL.has(T[k].w) || (T[k].w === 'india' && k + 1 < T.length && LEGAL.has(T[k + 1].w)))) k++;
  return k > j;
}

/** True if the record name starts with the core name (spaces and punctuation ignored). */
function startsWithCore(name, coreJoined) {
  if (!coreJoined) return false;
  const T = words(name);
  let acc = '';
  for (let i = 0; i < T.length; i++) {
    acc += T[i].w;
    if (acc === coreJoined) return tailOk(T, i + 1, T[i].comma);
    if (!coreJoined.startsWith(acc)) return false;
  }
  return false;
}

/** Result lists on the page: one per "search123" block, titled by the <li> heading above it. */
function sectionsOf(html) {
  const out = [];
  const re = /id=['"]search123['"]/g;
  let prevEnd = 0;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index;
    let end = html.indexOf('</div>', start);
    if (end < 0) end = html.length;
    const heads = [...html.slice(Math.max(prevEnd, start - 1000), start).matchAll(/<li>\s*<a[^>]*>([^<]*)<\/a>\s*<\/li>/gi)];
    const title = heads.length ? clean(heads[heads.length - 1][1]) : '';
    out.push({ title, body: html.slice(start, end).replace(/^id=['"]search123['"]\s*>/i, '') });
    prevEnd = end;
  }
  return out;
}

/** Rows of one result list. A row starts at a serial-number line, or at a "Direction to M/s ..." / "M/s ..." line, or at the top of the list. Its first line is the name. */
function rowsOf(body) {
  const text = decode(body.replace(/<\/?strong>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n'));
  const rows = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const sm = line.match(/^(\d{1,5})(?:\s+(.+))?$/);
    if (sm) {
      cur = { serial: sm[1], lines: [] };
      rows.push(cur);
      if (sm[2]) cur.lines.push(sm[2]);
      continue;
    }
    if (!cur || /^(direction|m\s*\/\s*s\b)/i.test(line)) {
      cur = { serial: '', lines: [] };
      rows.push(cur);
    }
    cur.lines.push(line);
  }
  return rows.filter((r) => r.lines.length);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const core = coreOf(String(keyword ?? ''));
    if (!core.joined) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no searchable words in the name' };
    }
    searchUrl = `${SEARCH}?q=${encodeURIComponent(core.term)}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const answered = html.includes('Search Result for');
    const sorry = html.includes('Sorry Not Found');
    if (!answered && !sorry) {
      if (/captcha|access denied|request rejected|are you a robot/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: clean(html).slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: clean(html).slice(0, 300) };
    }

    const secs = sectionsOf(html);
    const rowLists = secs.map((sec) => ({ sec, rows: rowsOf(sec.body) }));
    const rowCount = rowLists.reduce((n, x) => n + x.rows.length, 0);
    if (secs.length && rowCount === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: 'result lists found but no rows could be read' };
    }

    const hits = new Map();
    for (const { sec, rows } of rowLists) {
      for (const row of rows) {
        const name = row.lines[0]
          .replace(/^(directions?\s+(issued\s+)?(to\s+)?)?(m\s*\/\s*s\.?\s*)?/i, '')
          .replace(/\s+regarding\b[\s\S]*$/i, '')
          .trim();
        let ok = startsWithCore(name, core.joined);
        if (!ok) {
          // The page can cut the start of a row ("ormerly known as ..."), so accept the truncated form too.
          const alias = name.match(/(?:known\s+as|formerly|ormerly)\s+(?:known\s+as\s+)?(.+)$/i);
          ok = !!alias && startsWithCore(alias[1], core.joined);
        }
        if (!ok) continue;
        const key = `${sec.title}|${row.serial}|${name}`;
        if (!hits.has(key)) {
          hits.set(key, {
            name,
            serial_no: row.serial,
            list: sec.title,
            details: row.lines.slice(1).filter((l) => !/^view$/i.test(l)).join(' | '),
          });
        }
      }
    }

    const records = [...hits.values()];
    if (!records.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: sorry && !secs.length ? 'Sorry Not Found' : `${secs.length} result list(s), none for this company name`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records.map((r) => `${r.list}: ${r.name} | ${r.details}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
