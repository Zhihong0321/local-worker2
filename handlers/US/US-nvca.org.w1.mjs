export const meta = {
  task: 'US-nvca.org',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'website', 'city', 'state'],
  canary: { found: '1414 Ventures', not_found: 'Zyxwvut Quantum Dairy Holdings' },
};

const LIST_URL = 'https://nvca.org/nvca-members/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'sa', 'ag', 'nv', 'bv', 'pte', 'sdn', 'bhd']);

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare names: case, punctuation and legal form ignored. */
function nameKey(s) {
  const tokens = decode(s).toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.filter((t) => !LEGAL_FORMS.has(t)).join('');
}

function parseMembers(html) {
  const out = [];
  const rows = html.match(/<tr[^>]*class="[^"]*member_block[^"]*"[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const nameCell = row.match(/<td[^>]*class="[^"]*member_name[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (!nameCell) continue; // header row uses <th>
    const website = (nameCell[1].match(/href="([^"]*)"/i) || [])[1] || '';
    const name = cleanText(nameCell[1]);
    const city = cleanText((row.match(/<td[^>]*class="[^"]*member_city[^"]*"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || '');
    const state = cleanText((row.match(/<td[^>]*class="[^"]*member_state[^"]*"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || '');
    if (name) out.push({ name, website: decode(website), city, state });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = nameKey(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const members = parseMembers(html);
    if (!/NVCA Members/i.test(html) || !/member_name/.test(html) || members.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
    }

    const matches = members.filter((m) => nameKey(m.name) === kw);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No match in the ${members.length} firms listed on the NVCA members page`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: LIST_URL,
      excerpt: matches.map((m) => `${m.name}, ${m.city}, ${m.state}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
