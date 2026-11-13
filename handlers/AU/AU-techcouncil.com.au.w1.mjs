export const meta = { task: 'AU-techcouncil.com.au', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'membership', 'listed_in', 'source_url'],
  canary: { found: 'Canva', not_found: 'Zorblax Fenwick Holdings Pty Ltd' } };

const MEMBERS_URL = 'https://techcouncil.com.au/members/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['pty', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'plc', 'corp', 'corporation', 'co', 'company', 'sdn', 'bhd']);

function decodeEntities(s) {
  return (s || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&#8217;|&apos;/gi, "'")
    .replace(/&#8211;|&#8212;/g, '-').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').trim();
}

/** Core name for comparison: lower case, "&" as "and", punctuation dropped, trailing legal form removed. */
function coreName(str) {
  const tokens = decodeEntities(str).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

/** Logo names (img alt text) inside one part of the members page, de-duplicated, in page order. */
function logoNames(block) {
  const names = [];
  for (const m of block.matchAll(/<img\b[^>]*\balt="([^"]*)"/gi)) {
    const name = decodeEntities(m[1]);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(MEMBERS_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: MEMBERS_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: MEMBERS_URL, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();

    // Layout check: the "Current Members" logo block must be there and hold a plausible number of names.
    const iCurrent = html.indexOf('Current Members');
    if (iCurrent < 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: MEMBERS_URL, excerpt: 'no "Current Members" heading on the page' };
    }
    const iPartners = html.indexOf('Tech Council Partners Forum', iCurrent);
    const iSupporting = iPartners > 0 ? html.indexOf('Supporting Groups', iPartners) : -1;
    const currentBlock = html.slice(iCurrent, iPartners > 0 ? iPartners : undefined);
    const partnersBlock = iPartners > 0 ? html.slice(iPartners, iSupporting > 0 ? iSupporting : undefined) : '';

    const current = logoNames(currentBlock);
    if (current.length < 20) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: MEMBERS_URL, excerpt: `only ${current.length} logo names under "Current Members"` };
    }

    const want = coreName(keyword);
    const records = [];
    const sections = [['Current Members', current], ['Tech Council Partners Forum', logoNames(partnersBlock)]];
    for (const [section, names] of sections) {
      for (const name of names) {
        if (coreName(name) === want) {
          records.push({ name, membership: section === 'Current Members' ? 'Current member' : 'Partners Forum', listed_in: section, source_url: MEMBERS_URL });
        }
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: MEMBERS_URL,
        excerpt: `"${keyword}" is not among the ${current.length} logos under "Current Members" or the Partners Forum logos on ${MEMBERS_URL}`,
      };
    }
    return {
      status: 'found', reason: '', records, source_url: MEMBERS_URL,
      excerpt: `${records.map((r) => `${r.name} (${r.listed_in})`).join('; ')} on ${MEMBERS_URL}`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: MEMBERS_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
