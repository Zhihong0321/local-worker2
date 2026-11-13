export const meta = { task: 'MY-ricebowl.my', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'registration_no', 'address', 'company_size'],
  canary: { found: 'Telekom Malaysia', not_found: 'Syarikat Fiktif Tiada Rekod Sdn Bhd' } };

const BASE = 'https://www.ricebowl.my/company/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' };
const LEGAL_SUFFIX = /(sdnbhd|sdn|bhd|berhad|enterprise|plt|llp|ltd|limited|pte|llc|有限公司|有限责任公司)$/;
const LEGAL_WORD = /-(sdn|bhd|berhad|enterprise|plt|llp|ltd|limited|pte|llc)$/;

/** The site's slug rule, seen in its sitemap: lower case, punctuation removed, spaces become hyphens. */
function slugify(s) {
  return (s || '').normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim().replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The slug as typed, then the same slug without a trailing legal form (e.g. "telekom-malaysia-berhad"). */
function candidateSlugs(keyword) {
  const full = slugify(keyword);
  if (!full) return [];
  let bare = full;
  for (;;) {
    const next = bare.replace(LEGAL_WORD, '');
    if (next === bare || !next) break;
    bare = next;
  }
  return bare && bare !== full ? [full, bare] : [full];
}

/** Compare names: case, punctuation and a trailing legal form are ignored. */
function normName(s) {
  let n = (s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  let prev;
  do { prev = n; n = n.replace(LEGAL_SUFFIX, ''); } while (n !== prev && n.length);
  return n;
}

function decodeEntities(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

/** Read the profile: the schema.org LocalBusiness block gives the name and address; the page payload gives SSM and size. */
function parseProfile(html) {
  let biz = null;
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]);
      if (data && data['@type'] === 'LocalBusiness') { biz = data; break; }
    } catch { /* not this block */ }
  }
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const titleName = (title.match(/^Working at (.+?) - Company Profile/) || [])[1] || '';
  const name = decodeEntities((biz && biz.name) || titleName);
  if (!name) return null;
  const ssm = (html.match(/ssm:"([^"]{1,60})"/) || [])[1] || '';
  const size = (html.match(/size:"([^"]{1,40})",industry:/) || [])[1] || '';
  const address = decodeEntities(biz && biz.address && biz.address.name);
  return { name, record: { name, registration_no: ssm, address, company_size: size } };
}

function answer(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  let lastUrl = '';
  try {
    const slugs = candidateSlugs(kw);
    if (!slugs.length) return answer('couldnt_check', 'other', BASE, 'the name has no letters or digits to build the profile address');

    const notListed = [];
    for (const slug of slugs) {
      const url = BASE + encodeURIComponent(slug);
      lastUrl = url;
      let res;
      try {
        res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      } catch (err) {
        const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return answer('couldnt_check', timeout ? 'timeout' : 'other', url, String(err && err.message || err));
      }
      const html = await res.text();

      // A bot check or a refusal is never "not listed".
      if (res.status === 403 || res.status === 429 || /<title>Just a moment/i.test(html) || /cf_chl_opt/.test(html)) {
        return answer('couldnt_check', 'blocked', url, `HTTP ${res.status}: bot check or refusal`);
      }
      if (res.status === 404) {
        if (/can(&#x27;|')t seem to find the page/i.test(html)) { notListed.push(url); continue; }
        return answer('couldnt_check', 'http_error', url, 'HTTP 404 without the site\'s own not-found page');
      }
      if (!res.ok) return answer('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      const profile = parseProfile(html);
      if (!profile) {
        const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
        return answer('couldnt_check', 'layout_changed', url, title.slice(0, 300));
      }
      if (normName(profile.name) === normName(kw)) {
        return answer('found', '', url, `${profile.name} | SSM ${profile.record.registration_no} | ${profile.record.address}`.slice(0, 500), [profile.record]);
      }
      // A profile came back, but for a different company (the site can redirect a slug to another entry).
      notListed.push(`${url} -> "${profile.name}"`);
    }
    return answer('not_found', '', BASE + encodeURIComponent(slugs[0]),
      `No profile matches "${kw}": ${notListed.join('; ')}`.slice(0, 500));
  } catch (err) {
    return answer('couldnt_check', 'other', lastUrl || BASE, String(err && err.message || err).slice(0, 300));
  }
}
