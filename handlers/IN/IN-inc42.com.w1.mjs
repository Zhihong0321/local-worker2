export const meta = { task: 'IN-inc42.com', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'slug', 'founded', 'description', 'profile_url'],
  canary: { found: 'Ather Energy', not_found: 'भारत टेस्ट कंपनी प्राइवेट लिमिटेड' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://inc42.com/company/';

// Legal-form words that do not change which company is meant.
const LEGAL = /\b(private|pvt|limited|ltd|llp|opc|llc|inc|incorporated|corporation|corp|company|co)\b/gi;

function decodeEntities(s) {
  return (s || '').replace(/&#x27;|&#039;|&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripLegal(name) {
  return (name || '').replace(/[.,]/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
}

// Compare names: case, punctuation, spacing and legal form are ignored.
function normalize(name) {
  return stripLegal(name).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

// Profile slug, as the site writes it: "BYJU'S" -> "byjus", "Ather Energy Pvt Ltd" -> "ather-energy".
function slugFor(name, apostropheAsDash) {
  const base = apostropheAsDash ? stripLegal(name).replace(/['’`]/g, '-') : stripLegal(name).replace(/['’`]/g, '');
  return base.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function result(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim().replace(/\s+/g, ' ');
  if (!name) return result('couldnt_check', 'other', BASE, 'empty company name');

  // Inc42 keeps one profile page per company at /company/<slug>/. Try the two slug spellings, at most.
  const slugs = [...new Set([slugFor(name, false), slugFor(name, true)])].filter(Boolean);
  if (!slugs.length) return result('couldnt_check', 'other', BASE, 'no letters or digits in the name');

  let sawProfile = null;
  let firstUrl = '';
  try {
    for (const slug of slugs) {
      const url = BASE + encodeURIComponent(slug) + '/';
      if (!firstUrl) firstUrl = url;
      const res = await get(url);
      const html = await res.text();
      const finalUrl = res.url || url;

      if (res.status === 401 || res.status === 403 || res.status === 429 || /<title>\s*Just a moment|cf-chl-/i.test(html.slice(0, 20000))) {
        return result('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      }
      if (res.status >= 500) return result('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      // The site answers a missing profile with a redirect to its home page (or a 404): that is "not listed here".
      if (res.status === 404 || !finalUrl.startsWith(BASE)) continue;
      if (!res.ok) return result('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = decodeEntities(titleMatch ? titleMatch[1] : '');
      const pageName = title.split(/\s[—–-]\s|\s\|\s/)[0].trim();
      if (!pageName || !/Inc42/i.test(title)) {
        return result('couldnt_check', 'layout_changed', finalUrl, `title: ${title.slice(0, 200)}`);
      }

      const descMatch = html.match(/<meta name="description" content="([^"]*)"/i);
      const description = decodeEntities(descMatch ? descMatch[1] : '');
      const foundedMatch = description.match(/Founded in (\d{4})/);

      if (normalize(pageName) === normalize(name)) {
        return result('found', '', finalUrl, description, [{
          name: pageName,
          slug,
          founded: foundedMatch ? foundedMatch[1] : '',
          description,
          profile_url: finalUrl,
        }]);
      }
      sawProfile = { pageName, url: finalUrl };
    }
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return result('couldnt_check', timeout ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }

  if (sawProfile) {
    return result('not_found', '', sawProfile.url,
      `Inc42 has a company profile at this address, but it is for "${sawProfile.pageName}", not "${name}"`);
  }
  return result('not_found', '', firstUrl,
    `Inc42 has no company profile for "${name}": the address ${firstUrl} redirects to the Inc42 home page`);
}
