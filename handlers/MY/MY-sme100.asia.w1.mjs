// SME100 Awards (sme100.asia) - is a company a 2025 winner / Hall of Fame entry?
// Tier 2: open WordPress JSON API behind the pages (wp-json/wp/v2/pages?parent=...).
// Two lists are covered: Malaysia 2025 winners (winner-2025.php -> /event/hall-of-fame-2025/
// malaysia-winners-2025/) and ASEAN Hall of Fame 2025 (/asean/hall-of-fame-2025/).
// Plain HTTP only, no browser, one request per second, no login, no CAPTCHA.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LISTS = [
  {
    key: 'my2025',
    label: 'Malaysia 2025 winners (SME100)',
    year: '2025',
    parent: 5625,
    api: 'https://sme100.asia/event/wp-json/wp/v2/pages',
    pageUrl: 'https://sme100.asia/winner-2025.php',
    pathMarker: '/event/hall-of-fame-2025/malaysia-winners-2025/',
    nameMarker: 'AA AVIATION SDN BHD',
    min: 50,
  },
  {
    key: 'asean2025',
    label: 'ASEAN Hall of Fame 2025 (SME100)',
    year: '2025',
    parent: 2370,
    api: 'https://sme100.asia/asean/wp-json/wp/v2/pages',
    pageUrl: 'https://sme100.asia/asean/hall-of-fame-2025/',
    pathMarker: '/asean/hall-of-fame-2025/',
    nameMarker: 'APEIRON CONSULTANCY INC',
    min: 10,
  },
];

const LEGAL = new Set([
  'sdn', 'bhd', 'berhad', 'pte', 'ltd', 'limited', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'company', 'plc', 'llp', 'gmbh', 'pt', 'tbk', 'and',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;

async function politeGet(url) {
  const wait = lastAt + 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

function isChallenge(status, body) {
  if (status === 403 || status === 429 || status === 503) return true;
  const b = (body || '').slice(0, 4000).toLowerCase();
  return (
    b.includes('just a moment') ||
    b.includes('cf-challenge') ||
    b.includes('attention required') ||
    b.includes('captcha') ||
    b.includes('enable javascript and cookies')
  );
}

function tokens(s) {
  return String(s || '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .filter((w) => !LEGAL.has(w));
}

function score(qt, tt) {
  if (!qt.length || !tt.length) return 0;
  if (qt.join(' ') === tt.join(' ')) return 4;
  const qs = new Set(qt);
  const ts = new Set(tt);
  if ([...qs].every((x) => ts.has(x))) return 3; // the searched name sits inside the listed name
  if ([...ts].every((x) => qs.has(x))) return 2; // the listed name sits inside the searched name
  // looser: every searched word must be a listed word, or the start of one (MT Cafe -> MTC CAFE)
  const soft = qt.every((x) => tt.some((y) => y === x || (x.length >= 2 && y.startsWith(x))));
  return soft ? 1 : 0;
}

async function fetchList(list) {
  const items = [];
  for (let page = 1; page <= 3; page++) {
    const url =
      `${list.api}?parent=${list.parent}&per_page=100&page=${page}` +
      '&_fields=id,link,title,parent';
    const r = await politeGet(url);
    if (!r.ok) {
      if (isChallenge(r.status, r.body)) {
        return { error: 'blocked', evidence: `HTTP ${r.status} on ${url}` };
      }
      return { error: 'http_error', evidence: `HTTP ${r.status} on ${url}` };
    }
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      return {
        error: 'layout_changed',
        evidence: `wp-json did not return JSON (starts: ${r.body.slice(0, 120)})`,
      };
    }
    if (!Array.isArray(data)) {
      return { error: 'layout_changed', evidence: 'wp-json pages response is not an array' };
    }
    for (const it of data) {
      const link = it && it.link;
      const title = it && it.title && it.title.rendered;
      if (typeof link !== 'string' || typeof title !== 'string') {
        return {
          error: 'layout_changed',
          evidence: 'wp-json page object without link/title.rendered',
        };
      }
      items.push({ id: it.id, link, title });
    }
    if (data.length < 100) break;
  }
  // layout guards: the list must still look like this year's winner list
  if (items.length < list.min) {
    return {
      error: 'layout_changed',
      evidence: `only ${items.length} pages under parent ${list.parent} (expected >= ${list.min})`,
    };
  }
  if (!items.some((i) => i.link.includes(list.pathMarker))) {
    return {
      error: 'layout_changed',
      evidence: `no page link contains ${list.pathMarker}`,
    };
  }
  if (!items.some((i) => i.title.trim().toUpperCase() === list.nameMarker)) {
    return {
      error: 'layout_changed',
      evidence: `reference winner "${list.nameMarker}" missing from the list`,
    };
  }
  return { items };
}

async function enrich(record) {
  // best effort: the winner's own page carries website / contact person
  try {
    const r = await politeGet(record.url);
    if (!r.ok) return record;
    const html = r.body;
    if (!html.includes(record.name.split(' ')[0])) return record;
    const web =
      /<p>\s*Website\s*<\/p>\s*<p[^>]*>\s*<a[^>]*href="([^"]+)"/i.exec(html) ||
      /Website\s*<\/p>\s*<p[^>]*href="([^"]+)"/i.exec(html);
    if (web) record.website = web[1].trim();
    const ceo = /CEO\/Director'?s Name<\/p>\s*<p[^>]*>([^<]{2,80})</i.exec(html);
    if (ceo) record.ceo = ceo[1].trim();
    return record;
  } catch {
    return record;
  }
}

export const meta = {
  task: 'MY-sme100.asia',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'list', 'year', 'url', 'website', 'ceo'],
  canary: { found: 'AA Aviation', not_found: 'O2O Digital' },
};

export default async function lookup(keyword) {
  const q = String(keyword || '').trim();
  const empty = (reason, evidence, source) => ({
    status: 'couldnt_check',
    reason,
    records: [],
    source_url: source || 'https://sme100.asia/winner-2025.php',
    excerpt: String(evidence || '').slice(0, 500),
    notes: '',
  });
  if (!q) return empty('other', 'empty search term');

  const qt = tokens(q);
  if (!qt.length) return empty('other', `no usable tokens in "${q}"`);

  try {
    const found = [];
    const problems = [];
    let firstSource = '';

    for (const list of LISTS) {
      const res = await fetchList(list);
      if (res.error) {
        problems.push(`${list.key}: ${res.error} (${res.evidence})`);
        continue;
      }
      if (!firstSource) firstSource = list.pageUrl;
      for (const it of res.items) {
        const s = score(qt, tokens(it.title));
        if (s > 0) {
          found.push({
            s,
            name: it.title.trim(),
            list: list.label,
            year: list.year,
            url: it.link,
            _page: list.pageUrl,
          });
        }
      }
    }

    if (!found.length) {
      if (problems.length) {
        const blocked = problems.every((p) => p.includes('blocked'));
        return {
          status: 'couldnt_check',
          reason: blocked ? 'blocked' : 'layout_changed',
          records: [],
          source_url: firstSource || 'https://sme100.asia/winner-2025.php',
          excerpt: problems.join(' | ').slice(0, 500),
          notes: '',
        };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://sme100.asia/winner-2025.php',
        excerpt:
          `No 2025 SME100 winner or Hall of Fame entry matches "${q}". ` +
          'Checked all 84 Malaysia 2025 winners (winner-2025.php) and the ASEAN Hall of Fame 2025 list.',
        notes: 'live lists read through the site own wp-json pages endpoint',
      };
    }

    const best = Math.max(...found.map((f) => f.s));
    const picks = found.filter((f) => f.s === best);
    picks.sort((a, b) => a.name.length - b.name.length);
    const records = picks.slice(0, 5).map((f) => ({
      name: f.name,
      list: f.list,
      year: f.year,
      url: f.url,
    }));

    if (records.length) await enrich(records[0]);

    const excerpt = records
      .map((r) => `${r.name} — ${r.list} ${r.year}${r.website ? ' — ' + r.website : ''} — ${r.url}`)
      .join(' || ');

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: excerpt.slice(0, 500),
      notes: 'listed in the live 2025 SME100 winner / Hall of Fame lists',
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/abort|timeout/i.test(msg)) return empty('timeout', msg);
    return empty('other', msg);
  }
}
