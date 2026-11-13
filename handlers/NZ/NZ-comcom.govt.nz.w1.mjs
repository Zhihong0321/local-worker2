export const meta = {
  task: 'NZ-comcom.govt.nz',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'status', 'outcome', 'date_closed', 'category', 'match', 'url'],
  canary: { found: 'The Lines Company Limited', not_found: 'Kōkiri Tūhono Limited' },
};

const BASE = 'https://www.comcom.govt.nz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words removed from the END of a name before comparing (only when something is left before them).
const LEGAL_FORMS = new Set(['limited', 'ltd', 'incorporated', 'inc', 'plc', 'llc', 'co']);

/** Lower case, no accents, no punctuation, legal form at the end removed. */
function normName(s) {
  const words = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Same as normName but keeps the legal form, to tell an exact match from a legal-form difference. */
function squash(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Each result card on the case register list page. */
function parseCards(html) {
  return html.split('class="card card--has-link"').slice(1).map((block) => {
    const link = block.match(/<a class="card__link" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) return null;
    const field = (label) => clean(block.match(new RegExp(label + ':<\\/span>\\s*<span>([\\s\\S]*?)<\\/span>'))?.[1]);
    const tags = [...block.matchAll(/card__tag"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => clean(m[1])).filter(Boolean);
    return {
      url: new URL(decode(link[1]), BASE).href,
      title: clean(link[2]),
      status: clean(block.match(/card__status[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]),
      outcome: field('Outcome'),
      date_closed: field('Date Closed'),
      category: tags.join(', '),
    };
  }).filter(Boolean);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}/case-register/?q=${encodeURIComponent(keyword)}&size=100`;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 300) });
  try {
    if (!normName(keyword)) return fail('other', 'empty company name');

    const res = await fetch(searchUrl, {
      signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|cf-challenge|Just a moment/i.test(html)) return fail('blocked', 'bot check page');

    const total = Number(html.match(/:total="(\d+)"/)?.[1]);
    const noResults = /No results found/i.test(html);
    if (!Number.isFinite(total) && !noResults) return fail('layout_changed', html.slice(0, 300));
    if (noResults || total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'No results found.' };
    }

    const cards = parseCards(html);
    if (cards.length === 0) return fail('layout_changed', `total ${total} but no result cards`);

    const want = normName(keyword);
    const records = cards
      .filter((c) => normName(c.title) === want)
      .map((c) => ({ ...c, match: squash(c.title) === squash(keyword) ? 'exact' : 'same_name_other_legal_form' }));

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${total} search results; first ${cards.length} checked, none with this company name`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} case register entr${records.length === 1 ? 'y' : 'ies'} for "${records[0].title}": ${records[0].status}${records[0].outcome ? ', ' + records[0].outcome : ''}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
