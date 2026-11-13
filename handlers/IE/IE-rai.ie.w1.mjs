export const meta = { task: 'IE-rai.ie', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'website', 'address', 'description', 'listing'],
  canary: { found: 'Bibendum Ireland', not_found: 'Cuideachta Ghaelach Neamhní Teoranta' } };

const SOURCE_URL = 'https://www.rai.ie/approved-suppliers/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words removed from both sides before comparing (Irish and UK/IE forms).
const LEGAL_FORMS = new Set(['ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'unlimited', 'uc', 'llp', 'inc', 'llc', 'co', 'company', 'cuideachta']);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED_ENTITIES[n.toLowerCase()] !== undefined ? NAMED_ENTITIES[n.toLowerCase()] : m));
}

function safeChar(code, fallback) {
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: case, accents, punctuation, "&"/"and", leading "The" and legal form ignored; spaces ignored. */
function keyOf(name) {
  let tokens = decodeEntities(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length > 1 && tokens[0] === 'the') tokens = tokens.slice(1);
  return tokens.join('');
}

function parseSuppliers(html) {
  // Each supplier card starts with <li class="company-name">; the text up to the next card belongs to that card.
  const chunks = html.split(/<li class="company-name"[^>]*>/).slice(1);
  return chunks.map((chunk) => {
    const name = cleanText(chunk.split('</li>')[0]);
    const siteMatch = chunk.match(/<li class="icon contact-website">\s*<a href="([^"]*)"[^>]*>/);
    const addrMatch = chunk.match(/<li class="icon contact-address">([\s\S]*?)<\/li>/);
    const bioMatch = chunk.match(/<li class="icon contact-bio">([\s\S]*?)<\/li>/);
    const address = addrMatch ? cleanText(addrMatch[1]).split(',').map((p) => p.trim()).filter(Boolean).join(', ') : '';
    const bio = bioMatch ? cleanText(bioMatch[1]) : '';
    const description = /currently unavaiable/i.test(bio) ? '' : bio.slice(0, 400);
    return {
      name,
      website: siteMatch ? decodeEntities(siteMatch[1]) : '',
      address,
      description,
      listing: 'Approved suppliers',
    };
  }).filter((row) => row.name);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const typed = String(keyword || '');
    const wanted = keyOf(typed);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOURCE_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/cf-challenge|Just a moment\.\.\.|captcha/i.test(html.slice(0, 20000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SOURCE_URL, excerpt: 'bot check page' };
    }

    const suppliers = parseSuppliers(html);
    if (!html.includes('approved-suppliers') || suppliers.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SOURCE_URL, excerpt: html.slice(0, 300) };
    }

    // Match whole names only (after normalising); a name that merely contains or is contained in another never matches.
    const records = suppliers.filter((row) => {
      if (keyOf(row.name) === wanted) return true;
      const withoutBrackets = row.name.replace(/\([^)]*\)/g, '').trim();
      return withoutBrackets && keyOf(withoutBrackets) === wanted;
    });

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SOURCE_URL,
        excerpt: `"${typed}" is not on the approved suppliers list (${suppliers.length} entries checked)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: SOURCE_URL,
      excerpt: records.map((r) => `${r.name}${r.address ? ' | ' + r.address : ''}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: SOURCE_URL,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
