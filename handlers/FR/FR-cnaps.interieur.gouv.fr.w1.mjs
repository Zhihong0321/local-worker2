export const meta = { task: 'FR-cnaps.interieur.gouv.fr', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'document_code', 'decision_date', 'pdf_url'],
  canary: { found: 'GUARD INDUSTRY', not_found: 'Société Inexistante Introuvable' } };

const PAGE = 'https://www.cnaps.interieur.gouv.fr/Sanctions/Sanctions-Personnes-morales';
const ORIGIN = 'https://www.cnaps.interieur.gouv.fr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words, removed as whole tokens on both sides before comparing.
const LEGAL_FORMS = new Set(['SAS', 'SASU', 'SARL', 'SARLU', 'EURL', 'SA', 'SCI', 'SNC', 'SCOP', 'SELARL', 'SELAS', 'GIE', 'EI', 'EIRL']);

/** Upper-case, accents removed, punctuation removed, legal form words removed. */
function normalize(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Each sanction is a card: <h3 class="fr-card__title"><a href="...pdf">NAME - CD - YYYYMMDD</a></h3>. */
function parseEntries(html) {
  const entries = [];
  const re = /<h3 class="fr-card__title">\s*<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, ' '));
    const t = title.match(/^(.*?)\s+-\s+([A-Z]{2,4})\s*-\s*(\d{4})(\d{2})(\d{2})$/);
    entries.push({
      title,
      name: t ? t[1].trim() : title,
      code: t ? t[2] : '',
      date: t ? `${t[3]}-${t[4]}-${t[5]}` : '',
      pdf: new URL(decodeEntities(m[1]), ORIGIN).href,
    });
  }
  return entries;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const source = PAGE;
  try {
    const want = normalize(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: source, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: source, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: source, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!html.includes('Personnes morales')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: source, excerpt: html.slice(0, 300) };
    }

    const entries = parseEntries(html);
    if (entries.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: source, excerpt: 'no sanction cards found on the page' };
    }

    const matches = entries.filter((e) => normalize(e.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: source,
        excerpt: `The sanctions list (${entries.length} entries) has no entry for "${String(keyword).trim()}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({
        name: e.name,
        document_code: e.code,
        decision_date: e.date,
        pdf_url: e.pdf,
      })),
      source_url: source,
      excerpt: matches.map((e) => e.title).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: source, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
