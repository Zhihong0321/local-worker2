export const meta = {
  task: 'FR-numeum.fr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'sector', 'region', 'address', 'url'],
  canary: { found: '2B CONSULTING SAS', not_found: 'SOCIETE INEXISTANTE ZQXV SARL' },
};

// Numeum's member directory has one public page per member: /annuaire-des-adherents/<slug>/.
// The slug is the listed name, WordPress-style. A missing page (WordPress "Page not found", HTTP 404)
// means the name is not in the directory under that spelling.
const BASE = 'https://numeum.fr/annuaire-des-adherents/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL = new Set(['SAS', 'SASU', 'SARL', 'EURL', 'SA', 'SNC', 'SCI', 'SE', 'SELARL', 'SELAS', 'EI', 'SCOP', 'GIE']);
const SUFFIXES = ['sas', 'sarl', 'sasu', 'eurl', 'sa'];
const DEADLINE_MS = 45000; // stay well under the 60 s limit

function noAccents(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#0*39;|&#8217;/g, "'")
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Same rule as WordPress sanitize_title: no accents, lowercase, drop other punctuation, spaces to hyphens. */
function slugify(str) {
  return noAccents(str).toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function tokens(str) {
  return noAccents(str).replace(/\./g, '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

/** Name for comparison, without legal form and punctuation: "2B Consulting SAS" -> "2B CONSULTING". */
function core(str) {
  const t = tokens(str);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** The typed name with trailing legal-form words removed (original spelling kept). */
function stripLegal(str) {
  const w = str.trim().split(/\s+/);
  while (w.length > 1 && LEGAL.has(tokens(w[w.length - 1]).join(''))) w.pop();
  return w.join(' ');
}

/** Detail-page addresses to try: the typed name first, then without legal form, then common legal forms. */
function candidates(keyword) {
  const base = slugify(stripLegal(keyword));
  const slugs = [slugify(keyword), base, ...SUFFIXES.map((s) => `${base}-${s}`)];
  return [...new Set(slugs.filter(Boolean))].map((s) => BASE + s + '/');
}

function field(html, label) {
  const m = html.match(new RegExp(label + '<\\/span>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>', 'i'));
  return m ? cleanText(m[1]) : '';
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const text = String(keyword || '').trim();
  const urls = text ? candidates(text) : [];
  try {
    if (!text) return couldnt('other', BASE, 'empty company name');
    for (const url of urls) {
      const left = DEADLINE_MS - (Date.now() - started);
      if (left <= 0) return couldnt('timeout', url, 'the lookup did not finish in time');

      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
          signal: AbortSignal.timeout(Math.min(25000, left)),
        });
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return couldnt(timedOut ? 'timeout' : 'other', url, err?.message || err);
      }

      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      const html = await res.text();
      if (/captcha|cf-chl|challenge-platform/i.test(html)) return couldnt('blocked', url, 'bot check page');

      if (res.status === 404) {
        if (/Page not found/i.test(html)) continue; // normal answer: no member page under this name
        return couldnt('layout_changed', url, `HTTP 404 without the expected page: ${html.slice(0, 200)}`);
      }
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const h1 = html.match(/<h1[\s\S]*?<\/h1>/i);
      if (!h1 || !/Numeum/i.test(html)) return couldnt('layout_changed', url, html.slice(0, 300));
      const listedName = cleanText(h1[0]);
      if (core(listedName) !== core(text)) continue; // a different member on this address

      const sectorMatch = html.match(/text-ui-white">\s*([^<]+?)\s*<\/span>/i);
      const record = {
        name: listedName,
        sector: sectorMatch ? cleanText(sectorMatch[1]) : '',
        region: field(html, 'Région'),
        address: field(html, 'Adresse'),
        url,
      };
      return {
        status: 'found',
        reason: '',
        records: [record],
        source_url: url,
        excerpt: `${record.name} | ${record.sector} | ${record.region} | ${record.address}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: urls[0] || BASE,
      excerpt: `No Numeum member page under: ${urls.join(' , ')}`.slice(0, 500),
    };
  } catch (err) {
    return couldnt('other', urls[0] || BASE, err?.message || err);
  }
}
