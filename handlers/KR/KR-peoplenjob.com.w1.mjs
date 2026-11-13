export const meta = {
  task: 'KR-peoplenjob.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  input: 'company name',
  fields: ['name', 'slug', 'address', 'website', 'tags', 'profile_url'],
  canary: { found: '델 테크놀로지스', not_found: '가나다라마바사아자차타파' },
};

const BASE = 'https://www.peoplenjob.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko,en;q=0.8',
};

// Legal forms, Korean and English, removed before comparing names.
const LEGAL_FORMS = /\(주\)|주식회사|유한책임회사|유한회사|\(유\)|\bco\.?\s*,?\s*ltd\.?|\bltd\.?|\blimited\b|\bincorporated\b|\binc\.?|\bcorporation\b|\bcorp\.?|\bllc\b|\bgmbh\b|\bpte\.?|\bplc\b|\bco\b\.?/g;

function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(LEGAL_FORMS, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Read the company profile page for one slug. Returns the fields that are on the page; never throws. */
async function readProfile(slug) {
  const url = `${BASE}/jobs?company=${slug}`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { url, ok: false, excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    const start = html.indexOf('jd-company-card--profile');
    if (start < 0) return { url, ok: false, excerpt: 'profile card not found' };
    const endScript = html.indexOf('<script', start);
    const block = html.slice(start, endScript > start ? endScript : start + 8000);

    const nameMatch = block.match(/<a class="jd-v2-company-link"[^>]*>([\s\S]*?)<\/a>/);
    const addrMatch = block.match(/<div class="jd-company-card-meta">([\s\S]*?)<\/div>/);
    const linksMatch = block.match(/<div class="jd-company-card-links">([\s\S]*?)<\/div>/);
    const tags = [...block.matchAll(/<span class="jd-v2-tag">([\s\S]*?)<\/span>/g)].map((m) => cleanText(m[1])).filter(Boolean);

    const websites = [];
    if (linksMatch) {
      for (const m of linksMatch[1].matchAll(/redirect\('([^']+)'/g)) websites.push(decode(m[1]));
      for (const m of linksMatch[1].matchAll(/href="(https?:\/\/[^"]+)"/g)) websites.push(decode(m[1]));
    }

    return {
      url,
      ok: true,
      name: nameMatch ? cleanText(nameMatch[1]) : '',
      address: addrMatch ? cleanText(addrMatch[1]) : '',
      website: [...new Set(websites)].join(' '),
      tags: [...new Set(tags)],
      excerpt: [nameMatch && cleanText(nameMatch[1]), addrMatch && cleanText(addrMatch[1])].filter(Boolean).join(' | '),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { url, ok: false, excerpt: timeout ? 'profile timeout' : String(err?.message || err) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const searchUrl = `${BASE}/jobs?field=jobs.company_display_name&q=${encodeURIComponent(name)}`;
  try {
    if (!normalize(name)) return fail('other', searchUrl, 'empty company name');

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if ([401, 403, 429].includes(res.status)) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (res.url && new URL(res.url).pathname.startsWith('/auth')) {
      return fail('blocked', searchUrl, `redirected to ${res.url}`);
    }
    if (!html.includes('employment-number')) {
      if (/captcha|challenge-platform|cf-chl|접근이?\s*(제한|차단)/i.test(html)) {
        return fail('blocked', searchUrl, 'bot or captcha page');
      }
      return fail('layout_changed', searchUrl, html.slice(0, 300));
    }

    const countMatch = html.match(/employment-number"[^>]*>\s*([\d,]+)\s*</);
    const total = countMatch ? Number(countMatch[1].replace(/,/g, '')) : NaN;
    if (!Number.isFinite(total)) return fail('layout_changed', searchUrl, 'result count not found');

    // Company cards on the results page: one per job posting, with the company name and its profile slug.
    const cards = [...html.matchAll(/<a class="jd-card-company" href="\/jobs\?company=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => ({ slug: m[1], name: cleanText(m[2]) }));

    if (total === 0 && cards.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 results for "${name}"` };
    }
    if (cards.length === 0) return fail('layout_changed', searchUrl, `count ${total} but no company cards`);

    const target = normalize(name);
    const matchedSlugs = [...new Set(cards.filter((c) => normalize(c.name) === target).map((c) => c.slug))];
    if (matchedSlugs.length === 0) {
      const seen = [...new Set(cards.map((c) => c.name))].slice(0, 8).join(' / ');
      return fail('other', searchUrl,
        `${total} results, none with the exact name "${name}"; names returned: ${seen}`);
    }

    const records = [];
    for (const slug of matchedSlugs) {
      const card = cards.find((c) => c.slug === slug);
      const p = await readProfile(slug);
      records.push({
        name: (p.ok && p.name) || card.name,
        slug,
        address: p.ok ? p.address : '',
        website: p.ok ? p.website : '',
        tags: p.ok ? p.tags : [],
        profile_url: p.url,
      });
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.profile_url,
      excerpt: `${first.name} | ${first.address}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
