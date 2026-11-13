export const meta = {
  task: 'TH-amchamthailand.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'memid', 'address', 'phone', 'participation_level', 'profile_url'],
  canary: { found: 'Coca-Cola (Thailand) Limited', not_found: 'บริษัท กขคงจฉ ไม่มีอยู่จริง จำกัด' },
};

const BASE = 'https://connect.amchamthailand.com';
const SEARCH = BASE + '/list/search?q=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms (English and Thai) that are dropped before two names are compared.
const LEGAL = [
  /\bpublic company limited\b/g, /\bcompany limited\b/g, /\bco ltd\b/g, /\bpte ltd\b/g, /\bsdn bhd\b/g,
  /\bltd\b/g, /\blimited\b/g, /\bpcl\b/g, /\bplc\b/g, /\bcorporation\b/g, /\bcorp\b/g,
  /\bincorporated\b/g, /\binc\b/g, /\bllc\b/g, /\bbhd\b/g,
  /บริษัท/g, /จำกัด/g, /มหาชน/g,
];

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Lower case, punctuation and symbols removed, legal form removed, spaces removed.
// Thai combining marks are kept (they are not punctuation).
function normalize(name) {
  let s = (name || '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const re of LEGAL) s = s.replace(re, ' ');
  return s.replace(/[\s\p{P}\p{S}]+/gu, '');
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt };
}

// Each result is one <div class="card gz-results-card ..."> with data-memid, a name link, an address and a phone.
function parseCards(html) {
  return html.split('class="card gz-results-card').slice(1).map((part) => {
    const memid = (part.match(/data-memid="(\d+)"/) || [])[1] || '';
    const level = (part.match(/data-gz-wp="([^"]*)"/) || [])[1] || '';
    const title = part.match(/gz-card-title[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const address = part.match(/gz-card-address">([\s\S]*?)<\/li>/);
    const phone = part.match(/gz-card-phone">([\s\S]*?)<\/li>/);
    return {
      name: title ? cleanText(title[2]) : '',
      memid,
      address: address ? cleanText(address[1]) : '',
      phone: phone ? cleanText(phone[1]) : '',
      participation_level: decode(level),
      profile_url: title ? new URL(decode(title[1]), BASE).href : '',
    };
  }).filter((c) => c.name);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const url = SEARCH + encodeURIComponent(String(keyword || '').trim());
  try {
    const target = normalize(keyword);
    if (!target) return out('couldnt_check', 'other', [], url, 'empty company name');

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`);
    if (!res.ok) return out('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`);

    const html = await res.text();
    const countMatch = html.match(/gz-results-count">\s*(\d+)\s*</);
    if (!countMatch) {
      if (/challenge-platform|Just a moment\.\.\.|cf-chl/i.test(html)) return out('couldnt_check', 'blocked', [], url, 'bot check page');
      return out('couldnt_check', 'layout_changed', [], url, cleanText(html).slice(0, 300));
    }

    const total = Number(countMatch[1]);
    const cards = parseCards(html);
    const matches = cards.filter((c) => normalize(c.name) === target);

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(({ name, memid, address, phone, participation_level, profile_url }) =>
          ({ name, memid, address, phone, participation_level, profile_url })),
        source_url: url,
        excerpt: matches.map((c) => `${c.name} | ${c.address} | ${c.phone}`).join(' ;; ').slice(0, 500),
      };
    }

    if (total > cards.length) {
      return out('couldnt_check', 'other', [], url, `search reported ${total} results, only ${cards.length} were readable`);
    }

    return out('not_found', '', [], url, `${total} results, none with this name`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], url, String(err?.message || err).slice(0, 300));
  }
}
