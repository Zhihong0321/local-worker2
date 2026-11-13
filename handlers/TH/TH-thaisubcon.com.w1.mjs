export const meta = { task: 'TH-thaisubcon.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'name_en', 'member_id', 'cluster', 'province', 'phone', 'website', 'url'],
  canary: { found: 'PCD AERO SERVICES CO., LTD.', not_found: 'บริษัท ทดสอบไม่มีจริง จำกัด' } };

// Thai Subcon member directory JSON API: GET /api/members/search?q=<text>&page=<n>, 12 members per page.
// The search is a case-insensitive substring match over the member names (Thai and English). The handler searches
// by the most distinctive word of the company name, then compares full normalised names. A "not found" is only
// given when every member the search returns has been read. The site allows about 30 requests per minute.
const API = 'https://thaisubcon.com/api/members/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 3;      // a word matching more than 36 members is too broad to read in full
const MAX_WORDS = 3;      // longest words tried, in order
const DEADLINE_MS = 50000;

// Legal forms in Thai and English. They are removed before names are compared or searched.
const LEGAL = /บริษัท|จำกัด|\(มหาชน\)|มหาชน|ห้างหุ้นส่วน|ห้างร้าน|public\s+company\s+limited|company\s+limited|co\.?\s*,?\s*ltd\.?|co\.?\s*,?\s*limited|\bltd\.?|\blimited\b|\bpcl\b|\bplc\b|\bsdn\.?\s*bhd\.?|\binc\.?/gi;

function core(s) {
  return String(s || '').normalize('NFC').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return core(s).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

// Words of the name, longest first, without duplicates. Words of one or two characters are too broad to use.
function searchWords(s) {
  const words = core(s).split(/[^\p{L}\p{N}\p{M}]+/u).filter(w => w.length >= 2);
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getPage(q, page) {
  const url = `${API}?q=${encodeURIComponent(q)}&page=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status} for "${q}" page ${page}` };
  if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status} for "${q}" page ${page}` };
  let body;
  try { body = await res.json(); } catch { return { fail: 'layout_changed', detail: `"${q}" page ${page}: not JSON` }; }
  if (!body || body.success !== true || !Array.isArray(body.data) || !body.meta
      || !Number.isInteger(body.meta.total) || !Number.isInteger(body.meta.last_page)) {
    return { fail: 'layout_changed', detail: `"${q}" page ${page}: unexpected JSON shape` };
  }
  return { body };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // A short pause lets the HTTP sockets that fetch opened settle. Without it, Node 24 on Windows aborts
  // (libuv assertion, exit code 127) when the runner calls process.exit right after a fetch.
  await new Promise(resolve => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword ?? '').trim();
    const key = norm(kw);
    if (!key) return out('couldnt_check', 'other', [], API, 'the name is empty once the legal form is removed');

    const words = searchWords(kw);
    if (!words.length) return out('couldnt_check', 'other', [], API, 'the name has no word long enough to search');

    const broad = [];
    for (const word of words.slice(0, MAX_WORDS)) {
      if (Date.now() - started > DEADLINE_MS) return out('couldnt_check', 'timeout', [], API, 'the search passed 50 s');

      const first = await getPage(word, 1);
      if (first.fail) return out('couldnt_check', first.fail, [], API, first.detail);
      const { total, last_page: lastPage } = first.body.meta;
      if (lastPage > MAX_PAGES) { broad.push(`${word} (${total})`); continue; }

      const byId = new Map();
      const take = data => {
        for (const m of data) {
          if (!m || typeof m !== 'object' || m.id == null) return false;
          byId.set(m.id, m);
        }
        return true;
      };
      if (!take(first.body.data)) return out('couldnt_check', 'layout_changed', [], API, `"${word}": a member has no id`);
      for (let p = 2; p <= lastPage; p++) {
        if (Date.now() - started > DEADLINE_MS) return out('couldnt_check', 'timeout', [], API, 'the search passed 50 s');
        const r = await getPage(word, p);
        if (r.fail) return out('couldnt_check', r.fail, [], API, r.detail);
        if (!take(r.body.data)) return out('couldnt_check', 'layout_changed', [], API, `"${word}" page ${p}: a member has no id`);
      }
      if (byId.size !== total) {
        return out('couldnt_check', 'layout_changed', [], API, `"${word}": read ${byId.size} distinct members, the site reports ${total}`);
      }

      const hits = [...byId.values()].filter(m => norm(m.company_name) === key || norm(m.company_name_en) === key);
      if (!hits.length) {
        return out('not_found', '', [], API, `searched "${word}": read all ${total} matching members, none has this exact name`);
      }

      const records = hits.map(m => ({
        name: m.company_name || '',
        name_en: m.company_name_en || '',
        member_id: m.id,
        cluster: (m.cluster && (m.cluster.name_en || m.cluster.name)) || '',
        province: (m.province && m.province.name) || '',
        phone: m.phone || '',
        website: m.website || '',
        url: m.url || `https://thaisubcon.com/members/${m.id}`,
      }));
      const top = records[0];
      return out('found', '', records, top.url,
        `${top.name_en || top.name} | ${top.cluster} | ${top.province} (${records.length} exact match${records.length > 1 ? 'es' : ''})`);
    }

    return out('couldnt_check', 'other', [], API,
      `every word of the name matches more than ${MAX_PAGES * 12} members: ${broad.join(', ') || 'no word tried'}`);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return out('couldnt_check', timedOut ? 'timeout' : 'other', [], API, String(err?.message || err));
  }
}
