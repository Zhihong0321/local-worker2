export const meta = {
  task: 'IE-german-irish.ie',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'state', 'country', 'website', 'profile_url'],
  canary: { found: 'Arup', not_found: 'Cuideachta Gan Ainm Teoranta' },
};

const BASE = 'https://irland.ahk.de';
const DIR = `${BASE}/de/mitgliedschaft/mitgliederverzeichnis`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_PAGES = 12;
const DEADLINE_MS = 50000;

// Legal forms and the country word are dropped before comparing names ("ARUP IRELAND LTD" == "Arup").
const LEGAL = new Set(['ltd', 'limited', 'gmbh', 'mbh', 'plc', 'llp', 'ag', 'se', 'sa', 'sas', 'sarl', 'bv', 'nv',
  'inc', 'corp', 'co', 'company', 'dac', 'uc', 'teoranta', 'ug', 'kg', 'ohg', 'lp', 'llc', 'ireland', 'irl']);

function words(name) {
  const s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ');
  return s.split(/[^\p{L}\p{N}]+/u).filter((w) => w);
}

function key(name) {
  const w = words(name).filter((x) => !LEGAL.has(x));
  return w.length ? w.join('') : words(name).join('');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : '';
}

function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en,de;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
}

function blockedHtml(html) {
  return /captcha|cf-chl|just a moment|access denied/i.test(html);
}

function parseMembers(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*class="[^"]*members-list-link-to-member[^"]*"[^>]*>/g)) {
    const tag = m[0];
    const href = attr(tag, 'href');
    if (!href.includes('/de/mitgliedschaft/mitgliederverzeichnis/')) continue;
    const title = attr(tag, 'title').replace(/^Weiter zur /, '').replace(/ Seite$/, '').trim();
    out.push({ name: title, url: new URL(href, BASE).href });
  }
  return out;
}

function maxPage(html) {
  let max = 1;
  for (const m of html.matchAll(/members_directory_filter%5Bpage%5D=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

function parseDetail(html) {
  const h1 = (html.match(/<h1[^>]*member-details-header-title[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const fields = {};
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    fields[clean(m[1]).replace(/:$/, '').trim()] = clean(m[2]);
  }
  const linkTag = (html.match(/<a\b[^>]*class="[^"]*member-details-link[^"]*"[^>]*>/i) || [])[0] || '';
  return {
    name: clean(h1),
    address: fields['Adresse'] || '',
    state: fields['Bundesland/Provinz'] || '',
    country: fields['Land'] || '',
    website: attr(linkTag, 'href'),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const kw = String(keyword || '').trim();
  const ws = words(kw).filter((w) => !LEGAL.has(w));
  const term = ws.length ? ws.join(' ') : kw;
  const wantKey = key(kw);
  const pageUrl = (p) => `${DIR}?members_directory_filter%5BsearchTerm%5D=${encodeURIComponent(term)}` +
    (p > 1 ? `&members_directory_filter%5Bpage%5D=${p}` : '');
  const firstUrl = pageUrl(1);

  try {
    const res = await get(firstUrl);
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: firstUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: firstUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (!html.includes('Ergebnisse für')) {
      if (blockedHtml(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: firstUrl, excerpt: 'bot or captcha page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl, excerpt: html.slice(0, 300) };
    }

    let members = parseMembers(html);
    const pages = maxPage(html);
    const last = Math.min(pages, MAX_PAGES);
    for (let p = 2; p <= last; p++) {
      if (Date.now() - t0 > DEADLINE_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: firstUrl, excerpt: 'stopped before reading every result page' };
      }
      const r = await get(pageUrl(p));
      if (!r.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl(p), excerpt: `HTTP ${r.status}` };
      }
      members = members.concat(parseMembers(await r.text()));
    }
    if (pages > MAX_PAGES) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
        excerpt: `search has ${pages} result pages; only the first ${MAX_PAGES} were read` };
    }

    const matches = [];
    const seen = new Set();
    for (const m of members) {
      if (key(m.name) === wantKey && !seen.has(m.url)) { seen.add(m.url); matches.push(m); }
    }
    if (!matches.length) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `search "${term}" returned ${members.length} member(s), none with this name` };
    }

    const records = [];
    for (const m of matches.slice(0, 5)) {
      if (Date.now() - t0 > DEADLINE_MS) break;
      try {
        const d = await get(m.url);
        if (d.ok) {
          const info = parseDetail(await d.text());
          records.push({ name: info.name || m.name, address: info.address, state: info.state, country: info.country,
            website: info.website, profile_url: m.url });
          continue;
        }
      } catch (_) { /* fall through to the search-page record */ }
      records.push({ name: m.name, address: '', state: '', country: '', website: '', profile_url: m.url });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matches[0].url,
      excerpt: records.map((r) => `${r.name} | ${r.address} | ${r.state} | ${r.country}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
