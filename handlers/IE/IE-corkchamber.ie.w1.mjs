export const meta = {
  task: 'IE-corkchamber.ie',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'id', 'categories', 'address', 'phone', 'fax', 'website', 'about', 'profile_url', 'detail_status'],
  canary: { found: 'Abbey Rollers Ltd', not_found: 'Comhlacht Neamhliostaithe Teoranta' },
};

const BASE = 'https://chamber.corkchamber.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Optional extra calls (second search, member pages) only start before this point, so the whole call ends under 60 s.
const OPTIONAL_START_LIMIT_MS = 25000;
const LEGAL_WORDS = new Set(['ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'unlimited', 'cuideachta', 'inc', 'llc']);
const BLOCK_MARKERS = /cf-chl|challenge-platform|just a moment|captcha|turnstile|are you a robot|access denied/i;

/** Lower case, accents (fadas) removed, "&" as "and", punctuation removed. */
function fold(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Comparable form of a company name: legal form and a leading "the" removed. */
function core(s) {
  const words = fold(s).split(' ').filter(Boolean);
  if (words[0] === 'the') words.shift();
  return words.filter((w) => !LEGAL_WORDS.has(w)).join(' ');
}

/** Names a directory entry can be matched by: full name, legal part before "t/a", trading name, bracketed part. */
function nameKeys(name) {
  const full = String(name || '');
  const keys = new Set([core(full), core(full.replace(/\([^)]*\)/g, ' '))]);
  for (const part of full.split(/\s+(?:t\/a|trading as|trading name)\s+|[()]/i)) keys.add(core(part));
  keys.delete('');
  return keys;
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function plain(s) {
  return decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function out(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function failureFromError(url, e) {
  const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return out('couldnt_check', timeout ? 'timeout' : 'other', url, String(e?.message || e).slice(0, 200));
}

async function getText(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-IE,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.text();
  return { res, body };
}

/** One call to the directory's own search (the same endpoint its search box uses). */
async function findMembers(query) {
  const url = `${BASE}/list/find?q=${encodeURIComponent(query)}`;
  let got;
  try {
    got = await getText(url, 'application/json, text/javascript, */*;q=0.1');
  } catch (e) {
    return { failure: failureFromError(url, e) };
  }
  const { res, body } = got;
  if (res.status === 403 || res.status === 429) return { failure: out('couldnt_check', 'blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { failure: out('couldnt_check', 'http_error', url, `HTTP ${res.status}`) };
  const isJson = /json/i.test(res.headers.get('content-type') || '');
  if (!isJson && BLOCK_MARKERS.test(body.slice(0, 5000))) {
    return { failure: out('couldnt_check', 'blocked', url, 'bot check or challenge page returned') };
  }
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    return { failure: out('couldnt_check', 'layout_changed', url, body.slice(0, 200)) };
  }
  if (!Array.isArray(rows)) return { failure: out('couldnt_check', 'layout_changed', url, 'search answer is not a list') };
  const objects = rows.filter((x) => x && typeof x === 'object');
  if (objects.length && objects.every((x) => typeof x.Name !== 'string' || typeof x.ResultType !== 'number')) {
    return { failure: out('couldnt_check', 'layout_changed', url, JSON.stringify(rows[0]).slice(0, 200)) };
  }
  const members = objects.filter((x) => x.ResultType === 3 && typeof x.Name === 'string'
    && typeof x.ID === 'number' && typeof x.SlugWithID === 'string');
  return { members, count: rows.length, url };
}

/** Reads the member profile page. Only the member's own fields are taken (not the chamber's footer). */
function parseDetail(html) {
  const pick = (re) => { const m = html.match(re); return m ? plain(m[1]) : ''; };
  const categories = [...html.matchAll(/class="gz-cat">([\s\S]*?)<\/span>/g)].map((m) => plain(m[1])).filter(Boolean);
  const addrBlock = (html.match(/gz-card-address[\s\S]*?<\/li>/) || [''])[0];
  const address = [...addrBlock.matchAll(/itemprop="(streetAddress|addressLocality|addressRegion|postalCode|addressCountry)"[^>]*>([^<]*)</g)]
    .map((m) => plain(m[2])).filter(Boolean).join(', ');
  const website = decode((html.match(/gz-card-website[\s\S]*?href="([^"]+)"/) || [])[1] || '');
  const about = pick(/gz-details-about"[\s\S]*?<h3[^>]*>[\s\S]*?<\/h3>([\s\S]*?)<\/div>/).slice(0, 1000);
  return {
    categories,
    address,
    phone: pick(/itemprop="telephone">([^<]*)</),
    fax: pick(/itemprop="faxNumber">([^<]*)</),
    website,
    about,
  };
}

async function readMember(member, elapsed) {
  const record = {
    id: member.ID,
    name: member.Name,
    categories: [],
    address: '',
    phone: '',
    fax: '',
    website: '',
    about: '',
    profile_url: `${BASE}/list/member/${encodeURIComponent(member.SlugWithID)}`,
    detail_status: '',
  };
  if (elapsed() >= OPTIONAL_START_LIMIT_MS) {
    record.detail_status = 'skipped: time limit';
    return record;
  }
  try {
    const { res, body } = await getText(record.profile_url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
    if (!res.ok) {
      record.detail_status = `http ${res.status}`;
    } else if (!/gz-pagetitle|gz-details-header/.test(body)) {
      record.detail_status = 'layout_changed';
    } else {
      Object.assign(record, parseDetail(body));
      record.detail_status = 'ok';
    }
  } catch (e) {
    record.detail_status = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : `error: ${String(e?.message || e).slice(0, 120)}`;
  }
  return record;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  try {
    const kw = String(keyword ?? '').trim();
    const want = core(kw);
    if (!want) return out('couldnt_check', 'other', `${BASE}/list/find`, 'empty company name');

    const first = await findMembers(kw);
    if (first.failure) return first.failure;
    let members = first.members.filter((m) => nameKeys(m.Name).has(want));
    let searchUrl = first.url;
    let shown = first.count;

    // Second search without the legal form, in case the first list ranked the company out.
    const bare = kw.replace(/\b(ltd|limited|teoranta|dac|plc|unlimited)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!members.length && bare && bare !== kw) {
      if (elapsed() >= OPTIONAL_START_LIMIT_MS) {
        return out('couldnt_check', 'timeout', first.url, 'time ran out before the second search');
      }
      const second = await findMembers(bare);
      if (second.failure) return second.failure;
      searchUrl = second.url;
      shown = Math.max(shown, second.count);
      members = second.members.filter((m) => nameKeys(m.Name).has(want));
    }

    if (!members.length) {
      return out('not_found', '', searchUrl, `no member in the directory is named "${kw}" (${shown} search results, none with that name)`);
    }

    const records = [];
    for (const m of members.slice(0, 3)) records.push(await readMember(m, elapsed));
    const r = records[0];
    const excerpt = [r.name, r.categories.join(', '), r.address].filter(Boolean).join(' | ');
    return { status: 'found', reason: '', records, source_url: r.profile_url, excerpt: excerpt.slice(0, 500) };
  } catch (err) {
    return out('couldnt_check', 'other', `${BASE}/list/find`, String(err?.message || err));
  }
}
