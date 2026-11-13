export const meta = {
  task: 'IE-dublinchamber.ie',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'website', 'description'],
  canary: { found: 'Accenture Limited', not_found: 'Cuideachta Neamhliostaithe Gan Ainm' },
};

const PAGE = 'https://www.dublinchamber.ie/member-directory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words, removed from the END of a name only (so "Cuideachta Teoranta" keeps "Cuideachta").
const LEGAL = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'incorporated', 'co', 'company', 'uc',
  'unlimited', 'dac', 'designated', 'activity', 'teoranta', 'teo', 'sa', 'sas', 'srl', 'gmbh', 'bv', 'ag', 'lp']);

function normalise(s) {
  const t = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\./g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const parts = t ? t.split(' ') : [];
  while (parts.length > 1 && LEGAL.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

function decodeEntities(s) {
  const named = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(named, e) ? named[e] : m;
  });
}

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** The page carries the whole member list in a hidden form field (a JSON FetchModel). Returns its Data array or null. */
function extractMembers(html) {
  const inputs = html.match(/<input\b[^>]*>/gi) || [];
  for (const tag of inputs) {
    const v = tag.match(/\bvalue="([^"]*)"/i);
    if (!v || !v[1].includes('FetchModel')) continue;
    try {
      const data = JSON.parse(decodeEntities(v[1])).FetchModel?.Data;
      if (Array.isArray(data)) return data;
    } catch {
      return null;
    }
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = normalise(keyword);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const members = extractMembers(html);
    if (!members || !members.some(m => typeof m?.Fields?.name === 'string')) {
      if (/captcha|challenge-platform|cf-chl/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: 'bot check page' };
      }
      if (/type="password"/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: 'login wall' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: html.slice(0, 300) };
    }

    const matches = members.filter(m => normalise(m?.Fields?.name) === target);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `No exact name match among ${members.length} members in the public member directory`,
      };
    }

    const records = matches.map(m => ({
      name: clean(m.Fields.name),
      website: clean(m.Fields.websiteurl),
      description: clean(m.Fields.description).slice(0, 600),
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE,
      excerpt: `Listed in the member directory: ${records[0].name}${records[0].website ? ' - ' + records[0].website : ''}`,
    };
  } catch (err) {
    const name = err?.name || '';
    return {
      status: 'couldnt_check',
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
