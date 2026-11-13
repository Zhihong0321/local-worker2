export const meta = {
  task: 'TH-jobtopgun.com',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_en', 'profile_url', 'directory_page'],
  canary: { found: 'บริษัทคงความสุข จำกัด', not_found: 'บริษัท ทดสอบไม่มีอยู่จริง จำกัด' },
};

// JobTopGun's company directory lists every company on one letter page:
//   Thai names:    /th/company-directory/thai/<first Thai consonant of the name, after "บริษัท">
//   English names: /th/company-directory/eng/<A-Z>
//   Other:         /th/company-directory/other/0-9
// Each card links to /th/companies/<slug>-c<id>. The keyword decides which one page to read.

const BASE = 'https://www.jobtopgun.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&amp;/g, '&')
    .trim();
}

// Thai "ำ" may be written as "ํ"+"า" on the site: unify it before any comparison.
function fixThai(s) {
  return (s || '').normalize('NFC').replace(/ํา/g, 'ำ');
}

const THAI_LEGAL = ['บริษัท', 'จำกัด', 'มหาชน', 'บจก', 'บมจ', 'หจก'];
const ENG_LEGAL = new Set(['co', 'ltd', 'limited', 'public', 'company', 'pcl', 'plc', 'sdn', 'bhd', 'pte', 'inc']);

/** Comparable form of a company name: no case, punctuation, spaces or legal form. */
function norm(s) {
  let t = fixThai(s).toLowerCase();
  for (const w of THAI_LEGAL) t = t.split(w).join(' ');
  t = t.replace(/[^a-z0-9ก-๿]+/g, ' ').trim();
  return t.split(' ').filter((tok) => tok && !ENG_LEGAL.has(tok)).join('');
}

/** First Thai consonant of a Thai name, skipping the "บริษัท" prefix and leading vowel signs (เ แ โ ไ ใ). */
function thaiFirstConsonant(s) {
  const t = fixThai(s).replace(/^\s*บริษัท/, '').trim();
  for (const ch of t) {
    if (/[เ-ๅ\s"'(\[]/.test(ch)) continue;
    return /[ก-ฮ]/.test(ch) ? ch : '';
  }
  return '';
}

function parseCards(html) {
  const out = new Map();
  const re = /<a class="block group" href="(\/th\/companies\/[^"]+)"><span data-testid="companycard-primary"[^>]*>([^<]*)<\/span>(?:<span data-testid="companycard-secondary"[^>]*>([^<]*)<\/span>)?/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!out.has(m[1])) out.set(m[1], { href: m[1], name: decode(m[2]), en: decode(m[3] || '') });
  }
  return [...out.values()];
}

const answer = (status, reason, source_url, excerpt, records = []) => ({ status, reason, records, source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword ?? '').trim();
  let pageUrl = `${BASE}/th/company-directory/other/0-9`;
  let kind = 'other';
  try {
    if (!norm(kw)) return answer('couldnt_check', 'other', pageUrl, 'keyword has no name characters');

    const cons = /[ก-๿]/.test(kw) ? thaiFirstConsonant(kw) : '';
    if (cons) {
      pageUrl = `${BASE}/th/company-directory/thai/${encodeURIComponent(cons)}`;
      kind = 'thai';
    } else {
      const lead = norm(kw).charAt(0);
      if (/[a-z]/.test(lead)) {
        pageUrl = `${BASE}/th/company-directory/eng/${lead.toUpperCase()}`;
        kind = 'eng';
      }
    }

    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'th,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return answer('couldnt_check', 'blocked', pageUrl, `HTTP ${res.status}`);
    if (!res.ok) return answer('couldnt_check', 'http_error', pageUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const cards = parseCards(html);
    if (cards.length === 0 && !html.includes('company-directory-collectionpage')) {
      if (/cf-chl|Just a moment|captcha/i.test(html)) return answer('couldnt_check', 'blocked', pageUrl, 'bot check page');
      return answer('couldnt_check', 'layout_changed', pageUrl, html.slice(0, 300));
    }

    const want = norm(kw);
    const hits = cards.filter((c) => norm(c.name) === want || (c.en && norm(c.en) === want));
    if (hits.length) {
      return answer(
        'found',
        '',
        pageUrl,
        hits.map((c) => (c.en ? `${c.name} | ${c.en}` : c.name)).join(' ; ').slice(0, 500),
        hits.map((c) => ({ name: c.name, name_en: c.en, profile_url: BASE + c.href, directory_page: pageUrl })),
      );
    }

    // Thai names are listed under their Thai letter, so an empty match there is a real "not listed".
    if (kind === 'thai') {
      return answer('not_found', '', pageUrl, `${cards.length} companies on this page, none with this name`);
    }
    // English and other pages do not hold every company (Thai-named companies can be listed only under their Thai letter).
    return answer('couldnt_check', 'other', pageUrl,
      `no match on ${pageUrl}; the English/other pages are not a complete index, so absence cannot be confirmed`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer('couldnt_check', timeout ? 'timeout' : 'other', pageUrl, String(err?.message || err).slice(0, 300));
  }
}
