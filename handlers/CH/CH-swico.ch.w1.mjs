export const meta = { task: 'CH-swico.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'location', 'website'],
  canary: { found: '3M (Schweiz) GmbH', not_found: 'Löwenzahn Phantasie Gesellschaft AG' } };

// Swico member directory: one public page that lists every member company (name + town) in the HTML.
const LIST_URL = 'https://www.swico.ch/de/verband/mitgliedschaft/mitgliederverzeichnis/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped before comparing names ("3M (Schweiz) GmbH" == "3M Schweiz GmbH").
const LEGAL_FORMS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'limited', 'llc', 'inc', 'plc', 'kg', 'ug',
  'bv', 'nv', 'srl', 'spa', 'ab', 'oy']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function cleanText(html) {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: case, accents, umlauts, punctuation and legal form ignored. */
function matchKey(s) {
  const lower = s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const tokens = lower.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).filter((t) => !LEGAL_FORMS.has(t));
  // If only a legal form is left (e.g. the keyword is just "AG"), compare the plain text instead.
  return tokens.length ? tokens.join('') : lower.replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = typeof keyword === 'string' ? keyword.trim() : '';
    if (!input) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    let res;
    try {
      res = await fetch(LIST_URL, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timed = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { status: 'couldnt_check', reason: timed ? 'timeout' : 'other', records: [], source_url: LIST_URL,
        excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (/\/auth\/login/i.test(res.url || '')) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'redirected to login: ' + res.url };
    }

    const html = await res.text();
    const parts = html.split('xml-feed--row__item').slice(1);
    if (!html.includes('xml-feed--collection') || parts.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: cleanText(html).slice(0, 300) };
    }

    const members = [];
    let unreadable = 0;
    for (const part of parts) {
      const nameBlock = part.match(/itemprop="name"[^>]*>([\s\S]*?)<\/div>/);
      const name = nameBlock ? cleanText(nameBlock[1]) : '';
      if (!name) { unreadable++; continue; }
      const href = nameBlock[1].match(/href="([^"]+)"/);
      const town = part.match(/xml-feed--meta[^>]*>([\s\S]*?)<\/p>/);
      members.push({ name, location: town ? cleanText(town[1]) : '', website: href ? decode(href[1]) : '' });
    }

    const key = matchKey(input);
    const hits = members.filter((m) => matchKey(m.name) === key);

    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits,
        source_url: LIST_URL,
        excerpt: `${hits.length} match(es) in the Swico member directory (${members.length} members listed)`,
      };
    }
    // A row that could not be read might be the company, so "not listed" cannot be claimed.
    if (unreadable > 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: `${unreadable} directory row(s) could not be read; ${members.length} read` };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_URL,
      excerpt: `No match among ${members.length} members listed in the Swico member directory`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
