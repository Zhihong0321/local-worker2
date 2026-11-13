export const meta = {
  task: 'US-forbes.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['legal_name', 'profile_name', 'founded', 'headquarters', 'country', 'employees', 'ceo', 'details', 'profile_url'],
  canary: { found: 'Cargill', not_found: 'Dezeno' },
};

// Forbes company profile pages live at /companies/<slug>/ and are server-rendered (JSON-LD + profile-stats list).
// The site search box is client-side only, so the handler builds the slug from the name and checks the profile.
const BASE = 'https://www.forbes.com/companies/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'lp', 'llp', 'pllc']);

function tokens(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Name tokens without trailing legal-form words ("Cargill Inc" -> ["cargill"]). */
function stripped(name) {
  const t = tokens(name);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#x27;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

function parseProfile(html) {
  const out = { legalName: '', profileName: '', founded: '', employees: '', ceo: '', location: '', details: {} };
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      if (j && j['@type'] === 'Organization' && j.legalName) {
        out.legalName = j.legalName;
        out.founded = j.foundingDate != null ? String(j.foundingDate) : '';
        out.employees = j.numberOfEmployees != null ? String(j.numberOfEmployees) : '';
        out.location = j.location || '';
        if (j.employee && j.employee.name) out.ceo = j.employee.name;
        break;
      }
    } catch { /* ignore a block that is not JSON */ }
  }
  const h1 = html.match(/<h1[^>]*data-profile-name="([^"]+)"/i);
  if (h1) out.profileName = clean(h1[1]);
  for (const m of html.matchAll(/<dt class="profile-stats__title">([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const k = clean(m[1]);
    const v = clean(m[2]);
    if (k && v && out.details[k] === undefined) out.details[k] = v;
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const toks = stripped(keyword);
    if (!toks.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }
    const key = toks.join('');
    // Forbes slugs are the plain name ("publix-super-markets"); try the name without the legal form first, then as typed.
    const slugs = [...new Set([toks.join('-'), tokens(keyword).join('-')])];
    let lastUrl = BASE + slugs[0] + '/';

    for (const slug of slugs) {
      const url = BASE + slug + '/';
      lastUrl = url;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 404) continue; // no profile under this slug
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();
      const finalUrl = res.url || url;
      const p = parseProfile(html);
      if (!p.legalName && !p.profileName) {
        const blocked = /captcha/i.test(html);
        return {
          status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [],
          source_url: finalUrl, excerpt: clean(html).slice(0, 300),
        };
      }

      const profileName = p.legalName || p.profileName;
      if (stripped(profileName).join('') === key || stripped(p.profileName).join('') === key) {
        const hq = p.details['Headquarters'] || p.location || '';
        const country = p.details['Country/Territory'] || '';
        return {
          status: 'found',
          reason: '',
          records: [{
            legal_name: p.legalName || p.profileName,
            profile_name: p.profileName || p.legalName,
            founded: p.details['Founded'] || p.founded,
            headquarters: hq,
            country,
            employees: p.employees,
            ceo: p.ceo,
            details: p.details,
            profile_url: finalUrl,
          }],
          source_url: finalUrl,
          excerpt: [profileName, hq, p.details['Founded'] ? `founded ${p.details['Founded']}` : ''].filter(Boolean).join(' | '),
        };
      }

      // The site has a profile under this slug, but it is not clearly the same company: do not call it found or not_found.
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: finalUrl,
        excerpt: `profile "${profileName}" at this address is not clearly "${keyword}"`,
      };
    }

    return {
      status: 'not_found', reason: '', records: [], source_url: lastUrl,
      excerpt: `no Forbes company profile for "${keyword}" (HTTP 404 at ${slugs.map((s) => BASE + s + '/').join(', ')})`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: '',
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
