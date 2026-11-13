export const meta = { task: 'FR-franceassureurs.fr', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'group', 'address', 'postal_code', 'city', 'website', 'phone'],
  canary: { found: 'ABEILLE EPARGNE RETRAITE', not_found: 'SOCIETE DEZENO ASSURANCES' } };

const PAGE = 'https://www.franceassureurs.fr/qui-sommes-nous/nos-adherents/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['sa', 'sas', 'sasu', 'sarl', 'se', 'sci', 'snc', 'sca', 'eurl']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] ?? m));
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare-key: no case, accents, punctuation or trailing legal form ("AUXIA SA" and "Auxia S.A." are the same). */
function normalize(s) {
  const parts = decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let changed = true;
  while (changed && parts.length > 1) {
    changed = false;
    if (LEGAL_FORMS.has(parts[parts.length - 1])) { parts.pop(); changed = true; }
    else if (parts.length >= 3 && parts[parts.length - 2] === 's' && parts[parts.length - 1] === 'a') { parts.splice(-2); changed = true; }
  }
  return parts.join(' ');
}

/** The member list is server-rendered: one <li class="...content-item"> per company. */
function parseMembers(html) {
  const FIELD = /<(?:div|span)[^>]*class="who-block-adherents-fa__adherent-(titre|groupe|adresse-1|adresse-2|cedex|cp|ville|site-internet|telephone)"[^>]*>([\s\S]*?)<\/(?:div|span)>/g;
  const out = [];
  for (const chunk of html.split('who-block-adherents-fa__content-item"').slice(1)) {
    const f = {};
    for (const m of chunk.matchAll(FIELD)) {
      if (m[1] === 'site-internet') {
        const href = m[2].match(/<a[^>]*href="([^"]+)"/i);
        f.website = href ? decode(href[1]) : cleanText(m[2]);
      } else {
        f[m[1]] = cleanText(m[2]);
      }
    }
    if (!f.titre) continue;
    const address = [f['adresse-1'], f['adresse-2'], f.cedex].filter(Boolean).join(', ');
    out.push({
      name: f.titre,
      group: f.groupe || '',
      address,
      postal_code: f.cp || '',
      city: f.ville || '',
      website: f.website || '',
      phone: f.telephone || '',
    });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword ?? '');
    const kwNorm = normalize(kw);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    let res;
    try {
      res = await fetch(PAGE, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PAGE, excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!html.includes('who-block-adherents-fa')) {
      const walled = /captcha|cf-chl|challenge-platform|access denied/i.test(html.slice(0, 20000));
      return { status: 'couldnt_check', reason: walled ? 'blocked' : 'layout_changed', records: [], source_url: PAGE, excerpt: cleanText(html).slice(0, 300) };
    }

    const members = parseMembers(html);
    if (members.length < 100) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: `only ${members.length} member entries parsed` };
    }

    const hits = members.filter((m) => normalize(m.name) === kwNorm);
    if (!hits.length) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: `${members.length} members listed; none named "${kw}"` };
    }

    const h = hits[0];
    return {
      status: 'found',
      reason: '',
      records: hits,
      source_url: PAGE,
      excerpt: `${h.name}, ${h.postal_code} ${h.city}`.trim(),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
