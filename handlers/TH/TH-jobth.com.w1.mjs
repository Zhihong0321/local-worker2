export const meta = {
  task: 'TH-jobth.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'url', 'province', 'district', 'address', 'open_jobs', 'description'],
  canary: { found: 'บริษัท เซ็นทรัล รีเทล คอร์ปอเรชั่น จำกัด', not_found: 'บริษัท ซซซ ทดสอบไม่มีจริง จำกัด' },
};

const BASE = 'https://www.jobth.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 10; // the site lists 10 companies per results page
const MAX_PAGES = 5; // at most 50 hits are read
const LAST_START_MS = 25000; // no new fetch starts after 25 s, so the whole call stays under 60 s

const fail = (reason, url, excerpt = '') => ({
  status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300),
});

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Compare names without case, spaces, punctuation, the legal form or the word บริษัท.
function normName(str) {
  let s = String(str || '').normalize('NFC').toLowerCase();
  s = s.replace(/ำ/g, 'า').replace(/ํ/g, ''); // one spelling of "ำ" (จำ / จํา)
  s = s.replace(/บริษัท|ห้างหุ้นส่วนจากัด|ห้างหุ้นส่วน|จากัด|มหาชน|บจก|บมจ|หจก|public company limited|company limited|co\.?\s*,?\s*ltd\.?|\blimited\b|\bltd\b|\bpcl\b|\bco\b|\bcompany\b/g, ' ');
  return s.replace(/[^a-z0-9฀-๿]+/g, '');
}

// Number of companies the search reports, 0 for the "no such company" page, null if neither is shown.
function resultCount(html) {
  if (html.includes('ตรวจสอบไม่มีบริษัท')) return 0;
  const m = html.match(/ตรวจสอบระบบทั้งหมดพบ[\s\S]{0,80}?([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function parseResults(html) {
  const cards = html.split('<div class="w3-border w3-card w3-round-large w3-border-gray"').slice(1);
  const out = [];
  for (const card of cards) {
    const link = card.match(/<B>\s*<a href="([^"]*?\/(\d{10})\.html)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const pick = (re) => {
      const m = card.match(re);
      return m ? cleanText(m[1]) : '';
    };
    const jobs = card.match(/<span class="w3-badge[^"]*">\s*(\d+)\s*<\/span>\s*งาน/);
    out.push({
      name: cleanText(link[3]),
      company_id: link[2],
      url: new URL(link[1], BASE).href,
      province: pick(/จังหวัด\s*:\s*<a[^>]*>([\s\S]*?)<\/a>/),
      district: pick(/เขต\s*:\s*<a[^>]*>([\s\S]*?)<\/a>/),
      open_jobs: jobs ? Number(jobs[1]) : null,
      description: pick(/<div class="w3-text-gray w3-medium w3-padding">([\s\S]*?)<\/div>/),
    });
  }
  return out;
}

function parseAddress(html) {
  const m = html.match(/ที่อยู่<\/label>\s*<br>\s*([\s\S]*?)<\/p>/i);
  return m ? cleanText(m[1]) : '';
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'th,en;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { bad: true, reason: 'blocked', http: res.status };
  if (!res.ok) return { bad: true, reason: 'http_error', http: res.status };
  return { html: await res.text() };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const query = String(keyword || '').replace(/\s+/g, ' ').trim();
  const urlFor = (page) => `${BASE}/searchcombykeyword.php?keyword=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ''}`;
  const firstUrl = urlFor(1);
  try {
    if (query.length < 5) {
      return fail('other', firstUrl, 'the site needs at least 5 characters in its company search');
    }
    const target = normName(query);
    if (target.length < 2) {
      return fail('other', firstUrl, 'nothing is left to match after removing the legal form');
    }

    const first = await fetchPage(firstUrl);
    if (first.bad) return fail(first.reason, firstUrl, `HTTP ${first.http}`);
    const total = resultCount(first.html);
    if (total === null) {
      const reason = /captcha|access denied|cf-chl/i.test(first.html) ? 'blocked' : 'layout_changed';
      return fail(reason, firstUrl, cleanText(first.html).slice(0, 300));
    }
    let hits = parseResults(first.html);
    if (total > 0 && hits.length === 0) {
      return fail('layout_changed', firstUrl, cleanText(first.html).slice(0, 300));
    }

    let matches = hits.filter((h) => normName(h.name) === target);
    let matchUrl = firstUrl;
    let pagesRead = 1;
    let outOfTime = false;
    while (matches.length === 0 && pagesRead * PER_PAGE < total && pagesRead < MAX_PAGES) {
      if (Date.now() - started > LAST_START_MS) { outOfTime = true; break; }
      const url = urlFor(pagesRead + 1);
      const p = await fetchPage(url);
      if (p.bad) return fail(p.reason, url, `HTTP ${p.http}`);
      pagesRead += 1;
      hits = parseResults(p.html);
      matches = hits.filter((h) => normName(h.name) === target);
      if (matches.length) matchUrl = url;
    }

    if (matches.length) {
      const records = [];
      for (const m of matches.slice(0, 3)) {
        const rec = { ...m, address: '' };
        if (Date.now() - started < LAST_START_MS) {
          try {
            const d = await fetchPage(m.url);
            if (!d.bad) rec.address = parseAddress(d.html);
          } catch (e) {
            // the search already showed the company; the address stays empty
          }
        }
        records.push(rec);
      }
      const r0 = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchUrl,
        excerpt: `${r0.name} | ${r0.province} | ${r0.district} | open jobs ${r0.open_jobs ?? '?'}`,
      };
    }

    if (pagesRead * PER_PAGE < total) {
      if (outOfTime) return fail('timeout', matchUrl, `checked ${pagesRead} of ${Math.ceil(total / PER_PAGE)} pages before the time limit`);
      return fail('other', urlFor(pagesRead), `${total} companies match the search and the exact name is not in the first ${pagesRead * PER_PAGE}`);
    }

    // JobTH lists Thai names. An English-only search that finds nothing does not prove the company is absent.
    if (!/[฀-๿]/.test(query)) {
      return fail('other', firstUrl, 'the name has no Thai letters; JobTH lists Thai names, so an empty search does not prove the company is absent');
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: total === 0 ? 'ตรวจสอบไม่มีบริษัทที่ต้องการในระบบ' : `${total} companies matched the search; none has this name`,
    };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return fail(reason, firstUrl, String((err && err.message) || err));
  }
}
