export const meta = {
  task: 'IE-eplanning.ie',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'file_ref', 'council', 'application_status', 'decision_due_date', 'decision_date', 'decision', 'received_date', 'address', 'description', 'detail_url'],
  canary: { found: 'Kelly Precision Ltd.', not_found: 'Cuideachta Neamhliostaithe Teoranta' },
};

// What this searches: the "Applicant Name" search of each council portal on eplanning.ie (the 24 portals linked from
// https://www.eplanning.ie/). The records are planning applications, so a match means the company is named as the
// applicant on a planning application. Cork City, Cork County and Wexford run on another platform
// (planning.agileapplications.ie) and are NOT searched here.
const BASE = 'https://www.eplanning.ie';
const COUNCILS = ['CarlowCC', 'CavanCC', 'ClareCC', 'DonegalCC', 'GalwayCC', 'GalwayCity', 'KerryCC', 'KildareCC',
  'KilkennyCC', 'LaoisCC', 'LeitrimCC', 'LimerickCCC', 'LongfordCC', 'LouthCC', 'MayoCC', 'MeathCC', 'MonaghanCC',
  'OffalyCC', 'RoscommonCC', 'SligoCC', 'TipperaryCC', 'WaterfordCCC', 'WestmeathCC', 'WicklowCC'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'uc', 'unlimited', 'clg']);
const MAX_PAGES = 5;        // 10 rows per result page; pages beyond this are not read
const CONCURRENCY = 8;
const DEADLINE_MS = 50000;  // the whole call must finish in under 60 s
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = ENT[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function words(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function stripLegal(ws) {
  const w = ws.slice();
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

// Normalised company key: case, accents, punctuation and trailing legal form ignored.
function matchKey(s) {
  return stripLegal(words(s)).join('');
}

function cleanCell(td) {
  let s = td.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/\s+/g, ' ').replace(/(\s*,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
  return s.trim();
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"', 'i'));
  return m ? decode(m[1]) : null;
}

function gateOf(res) {
  if (res.status === 403 || res.status === 429) return 'blocked';
  if (!res.ok) return 'http_error';
  return null;
}

function pageGate(html) {
  if (/type=["']password["']/i.test(html) || /captcha/i.test(html)) return 'blocked';
  return null;
}

// One HTTP call with a cookie jar (Node fetch keeps no cookies by itself; the portal needs its anti-forgery cookie).
async function call(url, jar, init = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IE,en;q=0.9',
    ...(init.headers || {}),
  };
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers.Cookie = cookie;
  // One retry for a dropped connection ("fetch failed"); a timeout or a real HTTP answer is not retried.
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, { ...init, headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      break;
    } catch (e) {
      const transient = !/timeout|abort/i.test(`${e && e.name} ${e && e.message}`);
      if (attempt >= 2 || !transient) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const nv = c.split(';')[0];
    const i = nv.indexOf('=');
    if (i > 0) jar[nv.slice(0, i).trim()] = nv.slice(i + 1).trim();
  }
  return res;
}

// Reads the applicant-name search form: anti-forgery token, council checkboxes, hidden fields.
function readForm(html) {
  const tags = html.match(/<input\b[^>]*>/gi) || [];
  const txt = tags.findIndex((t) => attrOf(t, 'name') === 'TxtName');
  if (txt < 0) return null;
  let token = null;
  for (let i = 0; i < txt; i++) {
    if (attrOf(tags[i], 'name') === '__RequestVerificationToken') token = attrOf(tags[i], 'value');
  }
  const boxes = [];
  for (const t of tags) {
    const id = attrOf(t, 'id') || '';
    const m = id.match(/^CheckBoxList_(\d+)__Name$/);
    if (!m) continue;
    const i = m[1];
    const idTag = tags.find((x) => attrOf(x, 'id') === `CheckBoxList_${i}__Id`);
    boxes.push({ i, id: idTag ? attrOf(idTag, 'value') || '0' : '0', name: attrOf(t, 'value') || '' });
  }
  const countyTag = tags.find((t) => attrOf(t, 'id') === 'CountyTownCouncilNames');
  const countTag = tags.find((t) => attrOf(t, 'id') === 'CountyTownCount');
  const stTag = tags.find((t) => attrOf(t, 'name') === 'SearchType');
  if (!token || !boxes.length || !countyTag) return null;
  return {
    token,
    boxes,
    countyNames: attrOf(countyTag, 'value') || '',
    countyCount: countTag ? attrOf(countTag, 'value') || String(boxes.length) : String(boxes.length),
    searchType: stTag ? attrOf(stTag, 'value') || 'Exact' : 'Exact',
  };
}

function cellsOf(row) {
  return (row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || []).map((td) => td.replace(/^<td\b[^>]*>|<\/td>$/gi, ''));
}

// Reads one results page. Returns { ok, status, detail, rows, pages }.
function readResults(html, slug) {
  const gate = pageGate(html);
  if (gate) return { ok: false, status: gate, detail: 'login or captcha page' };
  if (!/Search Results/i.test(html) || !/<th\b[\s\S]*?Applicant Name/i.test(html)) {
    return { ok: false, status: 'layout_changed', detail: 'results table header not found' };
  }
  const rows = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const link = row.match(/href="([^"]*AppFileRefDetails[^"]*)"/i);
    if (!link) continue;
    const c = cellsOf(row).map(cleanCell);
    if (c.length < 10) return { ok: false, status: 'layout_changed', detail: `result row has ${c.length} cells` };
    rows.push({
      name: c[6],
      file_ref: c[0],
      application_status: c[1],
      decision_due_date: c[2],
      decision_date: c[3],
      decision: c[4],
      received_date: c[5],
      address: c[7],
      description: c[8],
      council: c[9],
      portal: slug,
      detail_url: new URL(decode(link[1]), BASE).href,
    });
  }
  const pg = html.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  const pages = pg ? parseInt(pg[2], 10) : 1;
  return { ok: true, rows, pages };
}

// Searches one council portal by applicant name and reads result pages (up to MAX_PAGES).
async function searchCouncil(slug, term, key) {
  const jar = {};
  const pageUrl = `${BASE}/${slug}/SearchExact/Name`;
  const r1 = await call(pageUrl, jar);
  const g1 = gateOf(r1);
  if (g1) return { slug, status: g1, detail: `HTTP ${r1.status}`, matches: [] };
  const h1 = await r1.text();
  const gp = pageGate(h1);
  if (gp) return { slug, status: gp, detail: 'login or captcha page', matches: [] };
  const form = readForm(h1);
  if (!form) return { slug, status: 'layout_changed', detail: 'search form not found', matches: [] };

  const params = new URLSearchParams();
  params.set('__RequestVerificationToken', form.token);
  params.set('TxtFileNumber', '');
  params.set('TxtName', term);
  params.set('TxtAddress', '');
  params.set('TxtDevdescription', '');
  for (const b of form.boxes) {
    params.append(`CheckBoxList[${b.i}].Id`, b.id);
    params.append(`CheckBoxList[${b.i}].Name`, b.name);
    params.append(`CheckBoxList[${b.i}].IsSelected`, 'true');
    params.append(`CheckBoxList[${b.i}].IsSelected`, 'false');
  }
  params.set('LstTimeLimit', '0');
  params.set('SearchType', form.searchType);
  params.set('CountyTownCount', form.countyCount);
  params.set('CountyTownCouncilNames', form.countyNames);

  const r2 = await call(`${BASE}/${slug}/searchresults`, jar, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': pageUrl },
    body: params.toString(),
  });
  const g2 = gateOf(r2);
  if (g2) return { slug, status: g2, detail: `HTTP ${r2.status}`, matches: [] };
  const first = readResults(await r2.text(), slug);
  if (!first.ok) return { slug, status: first.status, detail: first.detail, matches: [] };

  const matches = [];
  const take = (rows) => { for (const r of rows) if (r.name.split(',').some((p) => matchKey(p) === key && key)) matches.push(r); };
  take(first.rows);
  let pagesRead = 1;
  for (let p = 2; p <= Math.min(first.pages, MAX_PAGES); p++) {
    const rp = await call(`${BASE}/${slug}/searchresults/Default/${p}`, jar);
    const gp2 = gateOf(rp);
    if (gp2) return { slug, status: gp2, detail: `result page ${p}: HTTP ${rp.status}`, matches };
    const pr = readResults(await rp.text(), slug);
    if (!pr.ok) return { slug, status: pr.status, detail: `result page ${p}: ${pr.detail}`, matches };
    take(pr.rows);
    pagesRead = p;
  }
  const complete = pagesRead >= first.pages;
  return { slug, status: 'ok', complete, pagesRead, pages: first.pages, matches,
    detail: complete ? '' : `${first.pages} result pages; only ${pagesRead} read` };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const fallbackUrl = BASE + '/';
  try {
    const name = String(keyword || '').trim();
    const key = matchKey(name);
    if (!name || !key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: fallbackUrl, excerpt: 'empty company name' };
    }
    // The site matches part of the name; send the name without its legal form, then compare the full key.
    const term = stripLegal(words(name)).join(' ') || name;

    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < COUNCILS.length) {
        const slug = COUNCILS[next++];
        try {
          results.push(await searchCouncil(slug, term, key));
        } catch (e) {
          const txt = `${e && e.name} ${e && e.message}`;
          results.push({ slug, status: /timeout|abort/i.test(txt) ? 'timeout' : 'other',
            detail: String((e && e.message) || e).slice(0, 120), matches: [] });
        }
      }
    };
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, DEADLINE_MS); });
    await Promise.race([Promise.all(Array.from({ length: CONCURRENCY }, worker)), deadline]);
    clearTimeout(timer);

    const snapshot = results.slice();
    const byslug = new Map(snapshot.map((r) => [r.slug, r]));
    const matches = snapshot.flatMap((r) => r.matches || []);

    if (matches.length) {
      const portals = new Set(matches.map((m) => m.portal));
      return {
        status: 'found',
        reason: '',
        records: matches.slice(0, 200),
        source_url: matches[0].detail_url,
        excerpt: `${matches.length} planning application(s) name "${matches[0].name}" as applicant, in ${portals.size} council portal(s): ${[...portals].join(', ')}.`,
      };
    }

    const bad = COUNCILS.map((slug) => byslug.get(slug) || { slug, status: 'timeout', detail: 'not finished in 50 s' })
      .filter((r) => !(r.status === 'ok' && r.complete));

    if (!bad.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: fallbackUrl,
        excerpt: `Searched all ${COUNCILS.length} eplanning.ie council portals for applicant "${term}"; no matching application (each portal answered with an empty results table).`,
      };
    }

    const order = ['blocked', 'timeout', 'layout_changed', 'http_error', 'other'];
    const statusOf = (r) => (r.status === 'ok' ? 'other' : r.status);
    const reason = order.find((o) => bad.some((r) => statusOf(r) === o)) || 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: `${BASE}/${bad[0].slug}/SearchExact/Name`,
      excerpt: `No match in the ${COUNCILS.length - bad.length} portals read in full; not checked in full: ` +
        bad.map((r) => `${r.slug} ${r.status}${r.detail ? ' (' + r.detail + ')' : ''}`).join('; ').slice(0, 900),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: fallbackUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
