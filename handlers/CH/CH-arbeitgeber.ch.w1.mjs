export const meta = { task: 'CH-arbeitgeber.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'group', 'address', 'phone', 'website'],
  canary: { found: 'Swisscom AG', not_found: 'Bäckerei Zum Goldenen Brezel GmbH' } };

const LIST_URL = 'https://www.arbeitgeber.ch/ueber-uns/mitglieder/';
const SECTION_START = 'id="members-list-einzelmitglieder-title"';
const SECTION_END = 'data-pagination-list-value="members-list-einzelmitglieder"';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function text(html) {
  return decode(html.replace(/<[^>]+>/g, ' '));
}

// Compare names: case, accents, punctuation, a leading article and the legal form do not count.
function normalize(str) {
  let s = decode(str).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (s.length > 1 && ['die', 'der', 'das', 'le', 'la', 'les', 'il', 'lo', 'gli'].includes(s[0])) s.shift();
  const legal = ['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'ltd', 'kg', 'llc', 'inc'];
  while (s.length > 1 && legal.includes(s[s.length - 1])) s.pop();
  return s.join('');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (/challenge-platform|cf-chl|captcha/i.test(html.slice(0, 20000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'bot check page' };
    }

    // Only the "Einzelmitglieder" (direct member companies) block is read. Association members are not companies.
    const start = html.indexOf(SECTION_START);
    const end = start >= 0 ? html.indexOf(SECTION_END, start) : -1;
    if (start < 0 || end < 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
    }
    const block = html.slice(start, end);
    const cards = block.split('<article class="member-card">').slice(1);
    if (cards.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: 'no member cards in the list' };
    }

    const kw = normalize(keyword);
    const records = [];
    for (const card of cards) {
      const nameMatch = card.match(/<h3 class="member-card__name[^"]*">([\s\S]*?)<\/h3>/);
      if (!nameMatch) continue;
      const name = text(nameMatch[1]);
      // Full name, or its trailing acronym in capitals (e.g. "Schweizerische Bundesbahnen SBB" matches "SBB AG").
      const lastToken = name.split(' ').pop() || '';
      const acronym = /^[A-Z0-9]{2,}$/.test(lastToken) ? normalize(lastToken) : '';
      if (!kw || (normalize(name) !== kw && acronym !== kw)) continue;
      const addrMatch = card.match(/<address[^>]*>([\s\S]*?)<\/address>/);
      const phoneMatch = card.match(/<a class="member-card__phone"[^>]*>([\s\S]*?)<\/a>/);
      const webMatch = card.match(/<a class="contact-link" href="(https?:\/\/[^"]+)"[^>]*>\s*Webseite/);
      records.push({
        name,
        group: 'Einzelmitglieder (direct member company)',
        address: addrMatch ? text(addrMatch[1].match(/<p>([\s\S]*?)<\/p>/)?.[1] || '') : '',
        phone: phoneMatch ? text(phoneMatch[1].replace(/<span[^>]*>[\s\S]*?<\/span>/g, ' ')) : '',
        website: webMatch ? webMatch[1] : '',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `"${keyword}" is not among the direct member companies listed (Einzelmitglieder). The ~75 member associations on the page were not matched as companies.`,
      };
    }
    return {
      status: 'found', reason: '', records, source_url: LIST_URL,
      excerpt: records.map(r => `${r.name} | ${r.address} | ${r.phone}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: aborted ? 'timeout' : 'other', records: [], source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
