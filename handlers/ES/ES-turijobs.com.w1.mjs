export const meta = { task: 'ES-turijobs.com', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['name', 'alias', 'address', 'city', 'region', 'country', 'sector', 'employees', 'website', 'profile_url'],
  canary: { found: 'Pestana Hotel Group', not_found: 'Empresa Inexistente Zqxw SL' } };

const BASE = 'https://www.turijobs.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** The site's company profile address is the name in lower case, without accents, dots or other punctuation,
 *  words joined by "-". E.g. "Hesperia World S.L.U." -> "hesperia-world-slu", "Barceló Hotel Group" -> "barcelo-hotel-group". */
function slugOf(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const slug = slugOf(keyword);
  const pageUrl = `${BASE}/es-es/empresa/${slug}`;
  if (!slug) return couldnt('other', `${BASE}/es-es/empresas`, 'empty company name');

  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return couldnt('blocked', pageUrl, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', pageUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      const blocked = /captcha|challenge-platform|Just a moment|Attention Required/i.test(html);
      return couldnt(blocked ? 'blocked' : 'layout_changed', pageUrl, cleanText(html).slice(0, 300));
    }

    let pageProps;
    try {
      pageProps = JSON.parse(m[1])?.props?.pageProps;
    } catch {
      return couldnt('layout_changed', pageUrl, 'embedded page data is not JSON');
    }
    if (!pageProps || !('company' in pageProps)) {
      return couldnt('layout_changed', pageUrl, 'page has no company field');
    }
    if (String(pageProps.params?.slug || '').toLowerCase() !== slug) {
      return couldnt('layout_changed', pageUrl, `page answered for another slug: ${pageProps.params?.slug}`);
    }

    const c = pageProps.company;

    // A profile exists: it must be the one asked for (its own alias equals the slug).
    if (c && typeof c === 'object') {
      if (String(c.searchUrl || '').toLowerCase() !== slug || !c.enterpriseName) {
        return couldnt('layout_changed', pageUrl, `profile alias ${c.searchUrl} does not match ${slug}`);
      }
      const name = cleanText(c.enterpriseName);
      const sector = cleanText(c.sector);
      const city = cleanText(c.city);
      return {
        status: 'found',
        reason: '',
        records: [{
          name,
          alias: c.searchUrl,
          address: cleanText(c.address),
          city,
          region: cleanText(c.region),
          country: cleanText(c.country),
          sector,
          employees: c.employees ?? null,
          website: c.urlWeb || '',
          profile_url: pageUrl,
        }],
        source_url: pageUrl,
        excerpt: `${name} · ${sector} · ${city}`.slice(0, 500),
      };
    }

    // The site answered with its normal page for this address but holds no profile under it.
    const siteError = pageProps.error ? ` (site: ${pageProps.error})` : '';
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: `no company profile at ${pageUrl}${siteError}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timedOut ? 'timeout' : 'other', pageUrl, String(err?.message || err));
  }
}
