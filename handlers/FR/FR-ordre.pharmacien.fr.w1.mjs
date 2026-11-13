export const meta = { task: 'FR-ordre.pharmacien.fr', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'establishment_id', 'address', 'postcode_city', 'phone', 'fax', 'commercial_name'],
  canary: { found: 'selarl pharmacie centrale bazeries', not_found: 'SARL LABORATOIRE ZEPHYRIEN INEXISTANT' } };

const PAGE = 'https://www.ordre.pharmacien.fr/je-suis/patient-grand-public/l-annuaire-des-pharmaciens-etablissements';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL_FORMS = ['sas', 'sasu', 'sarl', 'selarl', 'selas', 'selurl', 'eurl', 'sa', 'sci', 'scp', 'sel', 'sca', 'snc'];

function normalise(str) {
  let s = (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s.split(' ').filter((t) => t && !LEGAL_FORMS.includes(t)).join(' ');
}

function decode(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&#0?39;|&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function cookieHeader(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const jar = new Map();
  try {
    // Step 1: open the directory page, keep its session cookie and read the form token.
    const getRes = await fetch(PAGE, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(25000) });
    if (getRes.status === 403 || getRes.status === 429) return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${getRes.status}` };
    if (!getRes.ok) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${getRes.status}` };
    const cookie = cookieHeader(getRes, jar);
    const pageHtml = await getRes.text();
    const tokenMatch = pageHtml.match(/id="annuaire__token"[^>]*value="([^"]+)"/);
    if (!tokenMatch || !pageHtml.includes('id="form-sf-etablissement"')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: 'directory form not found' };
    }

    // Step 2: search establishments by company name (legal form removed, the site matches the name as a substring).
    const core = normalise(keyword);
    if (!core) return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    const body = new URLSearchParams({
      'annuaire[type]': 'sf-etablissement', 'annuaire[etablissement_type]': '', 'annuaire[raison_social]': core,
      'annuaire[adresse_etablissement]': '', 'annuaire[zipcode_etablissement]': '', 'annuaire[city_etablissement]': '',
      'annuaire[_token]': tokenMatch[1],
    });
    const postRes = await fetch(`${PAGE}#vue-liste`, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Referer: PAGE, Cookie: cookie },
      body: body.toString(), signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${postRes.status}` };
    if (!postRes.ok) return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${postRes.status}` };
    const html = await postRes.text();
    if (!html.includes('id="vue-liste"')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: html.slice(0, 200) };
    }

    // Step 3: read the result buttons and keep only names that equal the company name after normalising.
    const buttons = html.match(/<button[^>]*\bres-pharmacie\b[^>]*>/g) || [];
    const hits = [];
    for (const tag of buttons) {
      const id = (tag.match(/data-id="(\d+)"/) || [])[1];
      const raison = decode((tag.match(/data-raisonsocial="([^"]*)"/) || [])[1]);
      const adresse = decode((tag.match(/data-adresse="([^"]*)"/) || [])[1]);
      if (id && normalise(raison) === core) hits.push({ id, raison, adresse });
    }

    const source = `${PAGE}  (search: raison_social=${core})`;
    if (!hits.length) {
      // The directory pages its results. If a next page exists, the name may be on it: do not call it not_found.
      if (html.includes('changeNextLink(')) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: source, excerpt: `no exact match on page 1 of several result pages for "${keyword}"` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: source, excerpt: `0 establishments named "${keyword}" in the directory (${buttons.length} results for the name)` };
    }

    // Step 4: read the detail block of each match (establishment fields only; pharmacists' names are not copied).
    const records = hits.map(({ id, raison, adresse }) => {
      const at = html.indexOf(`res-pharmacien-detail-${id}`);
      const block = at >= 0 ? html.slice(at, at + 6000) : '';
      const field = (label) => {
        const m = block.match(new RegExp(`<strong>\\s*${label}\\s*:?\\s*<\\/strong>\\s*<span>([\\s\\S]*?)<\\/span>`, 'i'));
        return m ? decode(m[1]) : '';
      };
      return {
        name: raison,
        establishment_id: id,
        address: field('Adresse') || adresse,
        postcode_city: field('Code postal - Ville'),
        phone: field('Téléphone'),
        fax: field('Télécopie'),
        commercial_name: field('Dénomination commerciale'),
      };
    });
    return { status: 'found', reason: '', records, source_url: source, excerpt: `${records.length} establishment(s) in the directory named "${records[0].name}"` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PAGE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
