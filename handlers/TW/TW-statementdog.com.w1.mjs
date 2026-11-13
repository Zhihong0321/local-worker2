export const meta = {
  task: 'TW-statementdog.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['code', 'name', 'industry_page'],
  canary: { found: '台積電', not_found: '虛構不存在科技股份有限公司' },
};

// StatementDog lists every company under its industry pages (/taiex/<n>-<industry>), as "<code> <short name>".
// The company pages (/analysis/<code>) are behind an AWS WAF challenge (HTTP 202), so only the lists are read.
const BASE = 'https://statementdog.com';
const INDEX_URL = `${BASE}/taiex`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Kept gentle: the site answers HTTP 429 to a burst of list pages (seen with 6 parallel reads).
const CONCURRENCY = 2;
const PAUSE_MS = 200;
// No new list is started after this many ms, so the whole call ends inside 60 s (one fetch takes up to 25 s).
const START_BUDGET_MS = 30000;
const REASON_ORDER = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised company name: case, punctuation, spaces, "-KY" and the legal form (股份有限公司, Co., Ltd., ...) removed. */
function normalize(name) {
  let t = String(name || '').normalize('NFKC').toLowerCase().trim();
  t = t.replace(/-\s*ky$/, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, '');
  const legal = /(股份有限公司|有限公司|股份有限|公司|limited|incorporated|company|corporation|ltd|inc|corp|co)$/;
  while (legal.test(t)) t = t.replace(legal, '');
  return t;
}

/** Industry list pages linked from the /taiex index. */
function industryLinks(indexHtml) {
  const out = [];
  const seen = new Set();
  for (const m of indexHtml.matchAll(/href="(\/taiex\/\d+-[^"]*)"/g)) {
    const path = decodeEntities(m[1]);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(new URL(path, BASE).href);
  }
  return out;
}

/** Companies on one industry list: anchors to /analysis/<code> whose text is "<code> <name>". */
function companiesOnPage(html) {
  const out = [];
  for (const m of html.matchAll(/href="\/analysis\/([0-9A-Za-z]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const code = m[1];
    const text = cleanText(m[2]);
    const parts = text.match(/^([0-9A-Za-z]+)\s+(.+)$/);
    if (parts && parts[1] === code) out.push({ code, name: parts[2].trim() });
  }
  return out;
}

async function get(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429 || res.status === 202 || res.headers.get('x-amzn-waf-action')) {
      return { ok: false, reason: 'blocked', status: res.status, text: '' };
    }
    if (res.status === 404) return { ok: false, reason: 'missing', status: 404, text: '' };
    if (!res.ok) return { ok: false, reason: 'http_error', status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', status: 0, text: '', error: String(err?.message || err).slice(0, 200) };
  }
}

async function scanPage(url, st) {
  if (st.found || st.blocked) return;
  if (Date.now() - st.started > START_BUDGET_MS) {
    st.failures.push({ reason: 'timeout', url, detail: 'not started: time budget used up' });
    return;
  }
  const r = await get(url);
  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  if (!r.ok) {
    if (r.reason === 'missing') st.missing.push(url);
    else st.failures.push({ reason: r.reason, url, detail: r.error || `HTTP ${r.status}` });
    // A refusal (rate limit, WAF challenge) ends the scan: no more list pages are requested after it.
    if (r.reason === 'blocked') st.blocked = true;
    return;
  }
  const entries = companiesOnPage(r.text);
  if (entries.length === 0) {
    // An industry page with no companies is read, not failed, when it carries the industry heading.
    if (/class="industry-title"/.test(r.text)) {
      st.scanned++;
    } else {
      st.failures.push({ reason: 'layout_changed', url, detail: `HTTP ${r.status}, no industry heading or company links` });
    }
    return;
  }
  st.scanned++;
  for (const e of entries) {
    if (normalize(e.name) === st.target && !st.found) {
      st.found = { ...e, url };
    }
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword ?? '').trim();
    const target = normalize(kw);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX_URL, excerpt: 'empty company name after normalising' };
    }

    const started = Date.now();
    const index = await get(INDEX_URL);
    if (!index.ok) {
      return { status: 'couldnt_check', reason: index.reason, records: [], source_url: INDEX_URL, excerpt: index.error || `HTTP ${index.status}` };
    }
    const pages = industryLinks(index.text);
    if (pages.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: INDEX_URL, excerpt: 'no /taiex/<n>-<industry> links on the index page' };
    }

    const st = { target, started, found: null, blocked: false, scanned: 0, failures: [], missing: [] };
    const queue = pages.slice();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0 && !st.found && !st.blocked) {
        await scanPage(queue.shift(), st);
      }
    }));

    if (st.found) {
      const f = st.found;
      return {
        status: 'found',
        reason: '',
        records: [{ code: f.code, name: f.name, industry_page: f.url }],
        source_url: f.url,
        excerpt: `${f.code} ${f.name}`,
      };
    }

    if (st.scanned === 0 || st.failures.length > 0) {
      const reasons = st.failures.map((x) => x.reason);
      const reason = REASON_ORDER.find((r) => reasons.includes(r)) || 'layout_changed';
      const first = st.failures.find((x) => x.reason === reason) || { url: INDEX_URL, detail: '' };
      return {
        status: 'couldnt_check',
        reason,
        records: [],
        source_url: first.url,
        excerpt: `read ${st.scanned} of ${pages.length} industry lists; ${st.failures.length} did not answer normally (${reasons.join(', ') || 'none readable'}). ${first.detail}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: INDEX_URL,
      excerpt: `No exact match for "${kw}" in ${st.scanned} industry lists (${pages.length - st.missing.length} pages). The site shows short names such as 台積電, so a registered legal name that differs from the short name cannot match.`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: INDEX_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
