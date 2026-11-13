export const meta = {
  task: 'MY-maukerja.my',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ssm', 'company_type', 'size', 'industry', 'address', 'profile_url'],
  canary: { found: 'A. K. Koh Enterprise Sdn. Bhd', not_found: 'Syarikat Tidak Wujud Sdn Bhd' },
};

const BASE = 'https://www.maukerja.my';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8',
};
// Labels of the company profile block (Malay UI). A value is the line right after its label.
const LABELS = ['Nama Syarikat', 'Jenis Syarikat', 'Saiz Syarikat', 'Industri', 'No. SSM Syarikat',
  'Peluang Pekerjaan', 'Laman Web Syarikat', 'Media Sosial Syarikat', 'Tentang'];
const LEGAL_TOKENS = new Set(['sdn', 'bhd', 'berhad']);
// The site's own "page not found" text (HTTP 404 page).
const SITE_NOT_FOUND = 'tiada dalam carian';

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

// The site's profile address is the company name in lower case, with punctuation and "&" removed and spaces as hyphens.
function slugify(name) {
  return name.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Names compared without case, punctuation and legal form (Sdn Bhd / Berhad).
function nameKey(name) {
  return decodeEntities(name).toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/)
    .filter((t) => t && !LEGAL_TOKENS.has(t)).join('');
}

function textLines(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '\n').replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, '\n');
  return decodeEntities(text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// The value is the next line after the label, unless that line is another label or empty.
function valueAfter(lines, from, label) {
  const i = lines.indexOf(label, from);
  if (i < 0) return '';
  const next = lines[i + 1];
  return next === undefined || LABELS.includes(next) ? '' : next;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword ?? '').trim().replace(/\s+/g, ' ');
  let url = BASE;
  try {
    if (!name) return couldnt('other', BASE, 'empty company name');
    // Names with non-Latin script (e.g. Chinese or Tamil) cannot be turned into the site's address reliably.
    if (/[^\p{Script=Latin}\p{N}\s.,&()'’\-\/]/u.test(name)) {
      return couldnt('other', BASE, 'name is not in Latin script; the site address is built from Latin names only');
    }
    const slug = slugify(name);
    if (!slug) return couldnt('other', BASE, 'name has no letters or digits to build the site address from');
    url = `${BASE}/company/${slug}`;

    let res;
    try {
      res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return couldnt(timeout ? 'timeout' : 'other', url, e?.message || e);
    }
    const html = await res.text();
    const finalUrl = res.url || url;

    if (res.status === 403 || res.status === 429) return couldnt('blocked', finalUrl, `HTTP ${res.status}`);
    if (res.status === 503 && /cf-chl|Just a moment|challenge-platform/i.test(html)) {
      return couldnt('blocked', finalUrl, `HTTP ${res.status} bot check`);
    }
    if (res.status === 404) {
      if (html.includes(SITE_NOT_FOUND)) {
        return { status: 'not_found', reason: '', records: [], source_url: finalUrl,
          excerpt: `HTTP 404: the site has no company page at this address (${slug})` };
      }
      return couldnt('http_error', finalUrl, 'HTTP 404 with an unexpected page');
    }
    if (!res.ok) return couldnt('http_error', finalUrl, `HTTP ${res.status}`);

    const lines = textLines(html);
    const start = Math.max(0, lines.findIndex((l) => l.startsWith('Maklumat ')));
    if (!lines.includes('Nama Syarikat')) {
      if (html.includes(SITE_NOT_FOUND)) {
        return { status: 'not_found', reason: '', records: [], source_url: finalUrl, excerpt: 'site says the page is not found' };
      }
      return couldnt('layout_changed', finalUrl, lines.slice(0, 8).join(' | '));
    }

    const siteName = valueAfter(lines, start, 'Nama Syarikat');
    if (!siteName) return couldnt('layout_changed', finalUrl, 'company name field is empty');

    // The address is built from the name, so check the name the page shows matches the one asked for.
    if (nameKey(siteName) !== nameKey(name)) {
      return { status: 'not_found', reason: '', records: [], source_url: finalUrl,
        excerpt: `the address for this name is the profile of "${siteName}", not "${name}"` };
    }

    const record = {
      name: siteName,
      ssm: valueAfter(lines, start, 'No. SSM Syarikat'),
      company_type: valueAfter(lines, start, 'Jenis Syarikat'),
      size: valueAfter(lines, start, 'Saiz Syarikat'),
      industry: valueAfter(lines, start, 'Industri'),
      address: (() => {
        const i = lines.findIndex((l, idx) => idx >= start && /^Alamat\b/.test(l));
        return i >= 0 && lines[i + 1] && !LABELS.includes(lines[i + 1]) ? lines[i + 1] : '';
      })(),
      profile_url: finalUrl,
    };
    const excerpt = [record.name, record.ssm && `SSM ${record.ssm}`, record.company_type, record.size,
      record.industry, record.address].filter(Boolean).join(' | ');
    return { status: 'found', reason: '', records: [record], source_url: finalUrl, excerpt: excerpt.slice(0, 500) };
  } catch (err) {
    return couldnt('other', url, err?.message || err);
  }
}
