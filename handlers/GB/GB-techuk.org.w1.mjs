export const meta = { task: 'GB-techuk.org', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['name', 'city', 'region', 'country', 'technology', 'markets', 'topics', 'sme', 'member_url'],
  canary: { found: 'Kainos', not_found: 'Zqxv Blorpington Gizmo Ltd' } };

const SOURCE = 'https://www.techuk.org/membership/members';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words stripped from the END of a name before comparing (so "Kainos Ltd" matches "Kainos").
const LEGAL = new Set(['ltd', 'limited', 'plc', 'llp', 'lp', 'cic']);
// The directory page should hold the whole list (about 1,100 members). Fewer than this means the page changed.
const MIN_MEMBERS = 100;

function fail(reason, excerpt, sourceUrl) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Compare names: lower case, punctuation and spaces ignored, legal form removed from the end. */
function normalise(s) {
  const tokens = String(s || '').replace(/&/g, ' and ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (tokens.length && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** The directory data is written into the page as escaped JSON text (React server payload). Undo one level of escaping. */
function unescapePayload(raw) {
  try { return JSON.parse('"' + raw + '"'); } catch { return null; }
}

/** Pull every member entry out of the page. Each entry starts with {"id":"<uuid>","name":"..." }. */
function parseMembers(html) {
  const head = /\{\\"id\\":\\"([0-9a-f-]{36})\\",\\"name\\":\\"((?:[^\\]|\\.)*?)\\",\\"/g;
  const starts = [];
  let m;
  while ((m = head.exec(html)) !== null) starts.push({ at: m.index, id: m[1] });

  const members = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : Math.min(html.length, starts[i].at + 3000);
    const text = unescapePayload(html.slice(starts[i].at, end));
    if (!text) continue;
    // The member object ends at its last closing brace inside this slice (or the first one, if the slice ran on).
    let obj = null;
    for (const cut of [text.lastIndexOf('}') + 1, text.indexOf('}') + 1]) {
      if (cut <= 0) continue;
      try { obj = JSON.parse(text.slice(0, cut)); break; } catch { obj = null; }
    }
    if (!obj || typeof obj.name !== 'string' || obj.id !== starts[i].id) continue;
    members.push({
      id: obj.id,
      name: obj.name,
      city: obj.city || '',
      region: obj.region || '',
      country: obj.country || '',
      technology: Array.isArray(obj.technology) ? obj.technology : [],
      markets: Array.isArray(obj.markets) ? obj.markets : [],
      topics: Array.isArray(obj.topics) ? obj.topics : [],
      sme: Array.isArray(obj.sme) ? obj.sme : [],
    });
  }
  return members;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalise(keyword);
    if (!key) return fail('other', 'empty company name', SOURCE);

    const res = await fetch(SOURCE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`, SOURCE);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`, SOURCE);

    const html = await res.text();
    const members = parseMembers(html);
    if (members.length < MIN_MEMBERS) {
      if (/just a moment|cf-chl|captcha|are you a robot/i.test(html)) return fail('blocked', 'bot check page', SOURCE);
      return fail('layout_changed', `only ${members.length} member entries found; page starts: ${html.slice(0, 200)}`, SOURCE);
    }

    const matches = members.filter((mem) => normalise(mem.name) === key);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SOURCE,
        excerpt: `No member named "${keyword}" among ${members.length} members listed on the techUK directory page`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((mem) => ({
        name: mem.name,
        city: mem.city,
        region: mem.region,
        country: mem.country,
        technology: mem.technology,
        markets: mem.markets,
        topics: mem.topics,
        sme: mem.sme,
        member_url: `https://www.techuk.org/membership/members/${mem.id}`,
      })),
      source_url: SOURCE,
      excerpt: `techUK member directory: ${matches.map((mem) => `${mem.name} (${[mem.city, mem.country].filter(Boolean).join(', ')})`).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', err?.message || err, SOURCE);
  }
}
