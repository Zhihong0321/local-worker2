export const meta = {
  task: 'SG-sccci.org.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'website'],
  canary: { found: 'AB ASSOCIATES PTE LTD', not_found: '新加坡虚构贸易私人有限公司' },
};

const LIST_URL = 'https://www.sccci.org.sg/site/member_list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_ENTRIES = 100; // the directory lists about 780 companies; far fewer means the page is not the one we expect

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] ?? m))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised company name: case, punctuation and the two common Singapore spellings of the private-limited form. */
function norm(s) {
  let t = decode(s).normalize('NFKC').toUpperCase();
  t = t.replace(/['’`"]/g, '');        // O'BRIEN -> OBRIEN
  t = t.replace(/&/g, ' AND ');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  t = t.replace(/\bPRIVATE LIMITED$/, 'PTE LTD').replace(/\bPTE LIMITED$/, 'PTE LTD');
  return t.replace(/\s+/g, ' ');
}

const LEGAL_FORM = /\s(PTE LTD|PTE|LTD|LIMITED|SDN BHD|BHD|LLP|LLC|INC|CORP|CO)$/;

/** Name without its legal-form ending, used only when the keyword itself has no legal form. */
function core(n) {
  let t = n;
  while (LEGAL_FORM.test(t)) t = t.replace(LEGAL_FORM, '');
  return t;
}

/** Parse the member entries from the directory page. Names with a website are <a>, the others are <div>. */
function parseEntries(html) {
  const start = html.indexOf('<div class="alpha-nav">');
  if (start < 0) return null;
  const navEnd = html.indexOf('</div>', start) + '</div>'.length;
  const footer = html.indexOf('<footer', navEnd);
  const section = html.slice(navEnd, footer > navEnd ? footer : undefined);
  const entries = [];
  const re = /<div class="member-list-item">([\s\S]*?)<\/div>|<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(section))) {
    if (m[1] !== undefined) {
      const name = decode(m[1]);
      if (name) entries.push({ name, website: '' });
    } else {
      const name = decode(m[3]);
      const href = decode(m[2]);
      if (name && href && !href.startsWith('#')) entries.push({ name, website: href });
    }
  }
  return entries;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = decode(keyword);
  try {
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty keyword' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|Just a moment/i.test(html.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'bot check page' };
    }
    if (String(res.url || '').includes('/cms/error') || !html.includes("Members' Directory")) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 200) };
    }

    const entries = parseEntries(html);
    if (!entries || entries.length < MIN_ENTRIES) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
               excerpt: `directory entries found: ${entries ? entries.length : 0}` };
    }

    const kwNorm = norm(kw);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'keyword has no letters or digits' };
    }
    const kwHasLegalForm = LEGAL_FORM.test(' ' + kwNorm);
    const kwCore = core(kwNorm);

    const seen = new Set();
    const records = [];
    for (const e of entries) {
      const en = norm(e.name);
      const exact = en === kwNorm;
      const sameCore = !kwHasLegalForm && core(en) === kwCore;
      if (!exact && !sameCore) continue;
      const key = en + '|' + e.website;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ name: e.name, website: e.website });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No match for "${kw}" in the SCCCI members directory (${entries.length} entries checked)`,
      };
    }

    return {
      status: 'found', reason: '', records, source_url: LIST_URL,
      excerpt: records.map(r => r.name + (r.website ? ' ' + r.website : '')).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
