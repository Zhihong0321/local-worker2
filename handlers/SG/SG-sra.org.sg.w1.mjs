export const meta = { task: 'SG-sra.org.sg', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'membership_category', 'website'],
  canary: { found: 'Harvey Norman', not_found: '新加坡虚构零售有限公司' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGES = [
  { url: 'https://www.sra.org.sg/membership/members/ordinary', category: 'Ordinary Member', title: 'Ordinary Members' },
  { url: 'https://www.sra.org.sg/membership/members/associate', category: 'Associate Member', title: 'Associate Members' },
];
const MEMBERS_URL = 'https://www.sra.org.sg/membership/members';
// Legal-form words, dropped from the end of a name before comparing (e.g. "ACME TRADING PTE LTD" -> "acme trading").
const LEGAL = new Set(['pte', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'plc', 'sdn', 'bhd', 'pvt', 'private']);
const MIN_CARDS = 20;

function decode(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normalize(s) {
  const words = decode(s).normalize('NFKC').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Each member is one card: <li class="border border-ink/15 ..."> with a link, a logo and a name span. */
function parseCards(html) {
  const cards = [];
  const re = /<li class="border border-ink\/15[^"]*">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[1];
    const name = block.match(/<span class="font-display[^"]*">([^<]*)<\/span>/);
    const link = block.match(/<a href="(https?:[^"]*)"/);
    if (name && decode(name[1])) {
      cards.push({ name: decode(name[1]), website: link ? decode(link[1]) : '' });
    }
  }
  return cards;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normalize(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: MEMBERS_URL, excerpt: 'name is empty after removing legal form' };
    }

    const listed = [];
    for (const page of PAGES) {
      const res = await fetch(page.url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: page.url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: page.url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const cards = parseCards(html);
      if (!html.includes(page.title) || cards.length < MIN_CARDS) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: page.url,
          excerpt: `${cards.length} member cards found on ${page.title} page` };
      }
      for (const c of cards) listed.push({ ...c, category: page.category, page: page.url });
    }

    const matches = listed.filter((c) => normalize(c.name) === kw);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((c) => ({ name: c.name, membership_category: c.category, website: c.website })),
        source_url: matches[0].page,
        excerpt: matches.map((c) => `${c.name} (${c.category})`).join('; ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: MEMBERS_URL,
      excerpt: `No match among ${listed.length} listed members (ordinary and associate) on ${MEMBERS_URL}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: MEMBERS_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
