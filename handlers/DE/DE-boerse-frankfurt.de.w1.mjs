export const meta = {
  task: 'DE-boerse-frankfurt.de',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'wkn', 'isin', 'profile_url'],
  canary: { found: 'Deutsche Börse AG', not_found: 'Nicht Vorhandene Firma GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.boerse-frankfurt.de/equity/';

// Equity profile pages are named after the company name: lower case, umlauts written out, spaces to hyphens.
// e.g. "Deutsche Börse AG" -> deutsche-boerse-ag, "Allianz SE" -> allianz-se.
function slugify(name) {
  return (name || '')
    .replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const LEGAL_FORMS = new Set(['ag', 'se', 'gmbh', 'kgaa', 'kg', 'ohg', 'ug', 'mbh', 'co', 'aktiengesellschaft', 'societas', 'europaea']);

// Normalised name for comparison: case, umlauts, punctuation and legal form removed.
function coreName(name) {
  const words = (name || '')
    .replace(/ß/g, 'ss').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.filter((w) => !LEGAL_FORMS.has(w)).join('');
}

const TITLE_RE = /<title>\s*(.+?) Equity \| ([A-Z0-9]{6}) \| ([A-Z]{2}[A-Z0-9]{9}\d) \| Share Price\s*<\/title>/;

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const slug = slugify(keyword);
  const url = BASE + slug;
  try {
    if (!slug) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      await res.text().catch(() => {}); // drain the body so the connection closes cleanly
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (res.status === 404) {
      // The site answers with its generic "not found" page when no equity profile exists under this name.
      await res.text().catch(() => {});
      return { status: 'not_found', reason: '', records: [], source_url: res.url || url, excerpt: `No equity profile at /equity/${slug} (HTTP 404)` };
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: res.url || url, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const finalUrl = res.url || url;
    const m = html.match(TITLE_RE);
    if (!m) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: finalUrl, excerpt: html.slice(0, 300) };
    }

    const [, pageName, wkn, isin] = m;
    if (coreName(pageName) !== coreName(keyword)) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: finalUrl,
        excerpt: `Profile at /equity/${slug} is for "${pageName}", not "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: [{ name: pageName.trim(), wkn, isin, profile_url: finalUrl }],
      source_url: finalUrl,
      excerpt: m[0].replace(/<\/?title>/g, '').trim(),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
