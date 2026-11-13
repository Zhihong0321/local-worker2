export const meta = {
  task: 'MY-sarawak-advocates.org.my',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'tel', 'fax', 'email', 'lawyers', 'page'],
  canary: { found: 'Abang Zen, Puk & Company (Miri)', not_found: 'Syarikat Tiada Wujud Sdn Bhd' },
};

// The "Legal Firms" directory is 12 static letter pages (A ... Z). Each page lists its firms as accordion entries:
// <div class="question"><div class="title">FIRM NAME</div><div class="answer">Address, Tel, Fax, E-mail, Lawyers</div></div>
const BASE = 'https://sarawak-advocates.org.my';
const PAGES = ['legal-firms', 'legal-firms-2', 'legal-firms-3', 'legal-firms-4', 'legal-firms-5', 'legal-firms-6',
  'legal-firms-7', 'legal-firms-8', 'legal-firms-9', 'legal-firms-rs', 'legal-firms-t', 'legal-firms-uvwyz']
  .map((p) => `${BASE}/${p}/`);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['sdn', 'bhd', 'berhad', 'llp', 'plt', 'ltd']);
const ENTRY_RE = /<div class="question">\s*<div class="title">(?:\s*<i[^>]*><\/i>)*([\s\S]*?)<\/div>\s*<div class="answer">([\s\S]*?)(?=<div class="question">|$)/g;
const BRANCH_RE = /\s*\([^()]*\)\s*$/;
const NAMED = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>' };

function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** HTML fragment to plain text, one line per <br> / block break. */
function textOf(html) {
  return decode(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Normalised company name: case, punctuation and legal-form words removed. */
function normName(s) {
  return decode(s).normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL_FORMS.has(t)).join(' ');
}

/** Exact match on the normalised name. A site entry with a branch in brackets, e.g. "(Miri)", matches a keyword
 *  without brackets only when the bracket-free name is identical. */
function isMatch(keyword, siteName) {
  const k = normName(keyword);
  if (!k) return false;
  if (normName(siteName) === k) return true;
  return !/[()]/.test(keyword) && normName(siteName.replace(BRANCH_RE, '')) === k;
}

function parseEntries(html, url) {
  const out = [];
  for (const m of html.matchAll(ENTRY_RE)) {
    const name = textOf(m[1]).replace(/\s*\n\s*/g, ' ').trim();
    const body = textOf(m[2]);
    const field = (re) => {
      const x = body.match(re);
      return x ? x[1].replace(/\s*\n\s*/g, ' ').trim() : '';
    };
    const lawyersPart = body.match(/(?:^|\n)\s*Lawyers?\b\s*:?\s*\n?([\s\S]*)$/i);
    const lawyers = lawyersPart ? lawyersPart[1].split('\n').map((l) => l.trim()).filter(Boolean) : [];
    if (!name) continue;
    out.push({
      name,
      address: field(/Address\s*:\s*([\s\S]*?)(?=\n?\s*(?:Tel|Fax|E-?mail)\s*:|\n\s*Lawyers?\b|$)/i),
      tel: field(/Tel\s*:\s*([\s\S]*?)(?=\n?\s*(?:Fax|E-?mail)\s*:|\n\s*Lawyers?\b|$)/i),
      fax: field(/Fax\s*:\s*([\s\S]*?)(?=\n?\s*E-?mail\s*:|\n\s*Lawyers?\b|$)/i),
      email: field(/E-?mail\s*:\s*([\s\S]*?)(?=\n\s*Lawyers?\b|$)/i),
      lawyers,
      page: url,
    });
  }
  return out;
}

async function loadPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { url, error: true, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { url, error: true, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    const entries = parseEntries(html, url);
    if (!entries.length) {
      const blocked = /captcha|cf-chl|challenge-platform|access denied/i.test(html);
      return { url, error: true, reason: blocked ? 'blocked' : 'layout_changed', excerpt: textOf(html).slice(0, 300) };
    }
    return { url, entries };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { url, error: true, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword ?? '').trim();
    if (!normName(kw)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGES[0], excerpt: 'empty company name' };
    }

    const pages = await Promise.all(PAGES.map(loadPage));
    const records = [];
    let firstMatchUrl = '';
    for (const p of pages) {
      if (p.error) continue;
      for (const e of p.entries) {
        if (isMatch(kw, e.name)) {
          records.push(e);
          if (!firstMatchUrl) firstMatchUrl = p.url;
        }
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstMatchUrl,
        excerpt: records.map((r) => r.name).join(' | ').slice(0, 500),
      };
    }

    // Not found is only a fair answer when every letter page was read.
    const failed = pages.find((p) => p.error);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.reason, records: [], source_url: failed.url, excerpt: failed.excerpt };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGES[0],
      excerpt: `Read all ${PAGES.length} Legal Firms pages (A to Z); no entry matches "${kw}"`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: PAGES[0],
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
