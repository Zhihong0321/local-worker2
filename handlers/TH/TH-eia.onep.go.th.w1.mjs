export const meta = {
  task: 'TH-eia.onep.go.th',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'owner_id', 'project_id', 'project_name', 'report_code', 'report_type', 'project_type', 'location', 'status', 'approve_number', 'approve_date', 'consultant', 'detail_url'],
  canary: { found: 'สหมิตร เรียลเอสเตท จำกัด', not_found: 'บริษัท ทดสอบไม่มีจริง จำกัด' },
};

const BASE = 'https://eia.onep.go.th';
const SEARCH_URL = BASE + '/site/eia';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TOTAL_MS = 55000;   // whole call must finish under 60 s
const MAX_PAGES = 5;      // search result pages read (about 10 projects each)
const DETAIL_BATCH = 8;   // detail pages fetched at a time

// Legal forms (Thai and English) that the registry may or may not write.
const LEGAL_RE = /บริษัท|จำกัด|\(?มหาชน\)?|ห้างหุ้นส่วน(?:จำกัด|สามัญ)?|หจก\.?|บจก\.?|co\.?\s*,?\s*ltd\.?|limited|\bltd\.?|\bcompany\b|\bco\b/gi;

/** Search text: the company name with its legal form removed. */
function coreName(s) {
  return String(s || '').normalize('NFC').replace(LEGAL_RE, ' ').replace(/[().,\-&]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Comparison key: case, spaces, punctuation and legal form ignored. */
function normalize(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(LEGAL_RE, '').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function cleanText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text of one label/value row on a detail page: from the label to the next row. */
function field(html, label) {
  const i = html.indexOf(label);
  if (i < 0) return '';
  const rest = html.slice(i + label.length);
  const end = rest.indexOf('<div class="row">');
  const part = (end < 0 ? rest.slice(0, 800) : rest.slice(0, end)).split('<!--')[0];
  return cleanText(part);
}

function ownersOf(html) {
  const i = html.indexOf('เจ้าของโครงการ :');
  if (i < 0) return [];
  const rest = html.slice(i + 'เจ้าของโครงการ :'.length);
  const end = rest.indexOf('<div class="row">');
  const block = end < 0 ? rest.slice(0, 800) : rest.slice(0, end);
  const links = [...block.matchAll(/owner-detail\?owner_id=(\d+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ id: m[1], name: cleanText(m[2]) }))
    .filter((o) => o.name);
  if (links.length) return links;
  const plain = cleanText(block);
  return plain ? [{ id: '', name: plain }] : [];
}

/** Rows of the result table: project id, plus the list cells that the detail page does not repeat. */
function parseRows(html) {
  const table = html.match(/<table[^>]*sticky-last[\s\S]*?<\/table>/);
  if (!table) return [];
  const rows = table[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const row of rows) {
    const m = row.match(/eia\/detail\?id=(\d+)/);
    if (!m) continue;
    const cells = (row.match(/<td[\s\S]*?<\/td>/g) || [])
      .filter((td) => !td.includes('eia/detail?id='))
      .map(cleanText);
    out.push({
      project_id: m[1],
      list: { status: cells[4] || '', approve_number: cells[5] || '', approve_date: cells[6] || '', project_type: cells[2] || '' },
    });
  }
  return out;
}

function parseCount(html) {
  const m = html.match(/ผลการค้นหาพบ<\/span>\s*"\s*([\d,]+)\s*รายการ"/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

/** Look one company up by owner name on the EIA registry. Must never throw. */
export default async function lookup(keyword) {
  const started = Date.now();
  const left = () => TOTAL_MS - (Date.now() - started);
  const fetchOpts = (extra = {}) => ({
    ...extra,
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.min(25000, Math.max(1000, left()))),
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'th,en;q=0.8',
      ...(extra.headers || {}),
    },
  });
  const fail = (status, reason, excerpt, source = SEARCH_URL) =>
    ({ status, reason, records: [], source_url: source, excerpt: String(excerpt || '').slice(0, 300) });
  const exceptionReason = (err) => (err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other');

  try {
    const core = coreName(keyword);
    if (!normalize(keyword)) return fail('couldnt_check', 'other', 'empty company name');
    if (!core) return fail('couldnt_check', 'other', 'name has no searchable words after removing the legal form');

    // 1. Open the search page: session cookie and CSRF token.
    const res1 = await fetch(SEARCH_URL, fetchOpts());
    if (res1.status === 403 || res1.status === 429) return fail('couldnt_check', 'blocked', `HTTP ${res1.status}`);
    if (!res1.ok) return fail('couldnt_check', 'http_error', `HTTP ${res1.status}`);
    const html1 = await res1.text();
    if (/captcha|cf-challenge|g-recaptcha/i.test(html1)) return fail('couldnt_check', 'blocked', 'captcha or bot check on the search page');
    const tokenMatch = html1.match(/name="eia_csrf-frontend" value="([^"]+)"/);
    if (!tokenMatch || !html1.includes('formSearch2')) {
      return fail('couldnt_check', 'layout_changed', html1.slice(0, 300));
    }
    const token = tokenMatch[1];
    const cookie = cookiesFrom(res1);

    const postPage = async (page) => {
      const body = new URLSearchParams({ 'eia_csrf-frontend': token, page: String(page), form_id: 'formSearch2', owner_name: core });
      const res = await fetch(SEARCH_URL, fetchOpts({
        method: 'POST',
        body: body.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': SEARCH_URL,
          'Origin': BASE,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }));
      if (res.status === 403 || res.status === 429) return { problem: fail('couldnt_check', 'blocked', `HTTP ${res.status}`) };
      if (!res.ok) return { problem: fail('couldnt_check', 'http_error', `HTTP ${res.status}`) };
      const html = await res.text();
      if (/captcha|cf-challenge|g-recaptcha/i.test(html)) return { problem: fail('couldnt_check', 'blocked', 'captcha or bot check on the search') };
      const count = parseCount(html);
      if (count === null) return { problem: fail('couldnt_check', 'layout_changed', html.slice(0, 300)) };
      return { count, rows: parseRows(html) };
    };

    // 2. Search by owner name, page 1.
    const first = await postPage(1);
    if (first.problem) return first.problem;
    const total = first.count;
    const seen = new Map();
    for (const r of first.rows) seen.set(r.project_id, r);

    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: `EIA search by owner "${core}" returned 0 projects` };
    }

    // 3. More result pages, in parallel.
    const pageSize = first.rows.length || 10;
    const pages = Math.min(MAX_PAGES, Math.ceil(total / pageSize));
    const truncated = Math.ceil(total / pageSize) > MAX_PAGES;
    if (pages > 1) {
      const extra = await Promise.all(Array.from({ length: pages - 1 }, (_, k) => postPage(k + 2).catch((e) => ({ problem: fail('couldnt_check', exceptionReason(e), e && e.message) }))));
      for (const p of extra) {
        if (p.problem) return p.problem;
        for (const r of p.rows) seen.set(r.project_id, r);
      }
    }

    // 4. Read each project's detail page and check the owner name.
    const ids = [...seen.keys()];
    const details = new Map();
    const failed = [];
    for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
      if (left() < 4000) { failed.push('time limit'); break; }
      const batch = ids.slice(i, i + DETAIL_BATCH);
      await Promise.all(batch.map(async (id) => {
        try {
          const url = `${BASE}/eia/detail?id=${id}`;
          const res = await fetch(url, fetchOpts({ headers: cookie ? { Cookie: cookie } : {} }));
          if (!res.ok) { failed.push(`detail ${id} HTTP ${res.status}`); return; }
          const html = await res.text();
          if (!html.includes('ชื่อโครงการ :')) { failed.push(`detail ${id} layout changed`); return; }
          details.set(id, html);
        } catch (e) {
          failed.push(`detail ${id} ${exceptionReason(e)}`);
        }
      }));
    }

    const wanted = normalize(keyword);
    const matched = [];
    for (const id of ids) {
      const html = details.get(id);
      if (!html) continue;
      const owners = ownersOf(html);
      const hit = owners.find((o) => normalize(o.name) === wanted);
      if (!hit) continue;
      matched.push({
        name: hit.name,
        owner_id: hit.id,
        project_id: id,
        project_name: field(html, 'ชื่อโครงการ :'),
        report_code: field(html, 'เลขที่รายงาน :'),
        report_type: field(html, 'ประเภทรายงาน :'),
        project_type: field(html, 'ประเภทโครงการ :') || seen.get(id).list.project_type,
        location: field(html, 'ที่ตั้งโครงการ :'),
        status: seen.get(id).list.status,
        approve_number: field(html, 'เลขที่หนังสือเห็นชอบ :') || seen.get(id).list.approve_number,
        approve_date: field(html, 'วันที่แจ้งเห็นชอบ :') || seen.get(id).list.approve_date,
        consultant: field(html, 'นิติบุคคลผู้ทำรายงาน :'),
        detail_url: `${BASE}/eia/detail?id=${id}`,
      });
    }

    if (matched.length) {
      const first1 = matched[0];
      return {
        status: 'found', reason: '', records: matched,
        source_url: first1.detail_url,
        excerpt: `${matched.length} project(s) with owner "${first1.name}" (owner_id ${first1.owner_id}); first: ${first1.project_name} (${first1.report_code}, ${first1.status})`
          + (truncated || failed.length ? ` [partial: ${total} projects matched the search, ${ids.length} read; ${failed.length} page(s) not read]` : ''),
      };
    }

    // No exact owner match. Only a clean read of every project may say not_found.
    if (failed.length) {
      return fail('couldnt_check', failed.some((f) => f.includes('time limit') || f.includes('timeout')) ? 'timeout' : 'http_error',
        `${failed.length} project page(s) could not be read: ${failed.slice(0, 3).join('; ')}`);
    }
    if (truncated) {
      return fail('couldnt_check', 'other', `search returned ${total} projects; only the first ${ids.length} were read and none had the owner name`);
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
      excerpt: `EIA search by owner "${core}" returned ${total} project(s); none has an owner named exactly "${keyword}"`,
    };
  } catch (err) {
    return fail('couldnt_check', exceptionReason(err), err && err.message);
  }
}
