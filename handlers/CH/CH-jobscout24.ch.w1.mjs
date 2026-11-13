export const meta = {
  task: 'CH-jobscout24.ch',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'location', 'open_jobs'],
  canary: { found: '20 Minuten', not_found: 'Fantasiefirma Musterhaus Schweiz GmbH' },
};

const BASE = 'https://www.jobscout24.ch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5',
};

// Legal-form words. Only removed from the END of a name, on both sides of the comparison.
const LEGAL_FORMS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'co', 'kg', 'se', 'plc', 'corp', 'bv', 'nv']);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** Returns { key, initial }: key = comparable name, initial = first letter of the name (accents folded). */
function fold(name) {
  const base = decodeEntities(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const initial = base.charAt(0);
  let t = base.replace(/\bs\.?\s*a\.?\s*r\.?\s*l\.?(?![a-z0-9])/g, ' sarl ');
  const words = t.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return { key: words.join(''), initial };
}

/** The company index: one anchor per company on each letter page. */
function parseEntries(html) {
  const out = [];
  const tags = html.match(/<a\b[^>]*class="[^"]*\bcompany-profile-sitemap\b[^"]*"[^>]*>/g) || [];
  for (const tag of tags) {
    const t = tag.match(/\btitle="([^"]*)"/);
    const h = tag.match(/\bhref="([^"]*)"/);
    if (!t || !h || !h[1].includes('/company/')) continue;
    out.push({ name: decodeEntities(t[1]).trim(), href: h[1] });
  }
  return out;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // On Node 24 / Windows the process can abort on exit while a fetch keep-alive socket is still open
  // (libuv assertion, exit 127) even after the answer is printed. A short pause lets the sockets settle first.
  await new Promise((r) => setTimeout(r, 1500));
  return answer;
}

async function run(keyword) {
  const input = String(keyword || '').trim();
  let listUrl = `${BASE}/de/sitemap/jobs-nach-firmen/-/`;
  try {
    const { key, initial } = fold(input);
    if (!key) return couldnt('other', listUrl, 'the name is empty after removing punctuation and legal form');

    // The index has one page per letter a-z, and one page ("-") for names starting with a digit.
    const page = /[a-z]/.test(initial) ? initial : /[0-9]/.test(initial) ? '-' : null;
    if (!page) {
      return couldnt('other', listUrl, `no index page for names starting with "${initial}" (index covers a-z and digits)`);
    }
    listUrl = `${BASE}/de/sitemap/jobs-nach-firmen/${page}/`;

    const res = await fetch(listUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', listUrl, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', listUrl, `HTTP ${res.status}`);
    const html = await res.text();
    if (!/company-profile-sitemap/.test(html) && /captcha|cf-chl|Just a moment/i.test(html)) {
      return couldnt('blocked', listUrl, 'bot check page instead of the index');
    }

    const entries = parseEntries(html);
    if (entries.length === 0) return couldnt('layout_changed', listUrl, cleanText(html));

    const matches = entries.filter((e) => fold(e.name).key === key);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: listUrl,
        excerpt: `No company named "${input}" on index page "${page}" (${entries.length} entries checked)`,
      };
    }

    // Found: read each matching company profile for location and open jobs. A failed profile read keeps the record.
    const records = [];
    const notes = [];
    for (const m of matches.slice(0, 5)) {
      const rec = { name: m.name, profile_url: BASE + m.href, location: '', open_jobs: null };
      try {
        const r = await fetch(rec.profile_url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (r.ok) {
          const text = cleanText(await r.text());
          const jobs = text.match(/hat aktuell (\d+) Stellen? ausgeschrieben/);
          if (jobs) rec.open_jobs = Number(jobs[1]);
          const locs = [...text.matchAll(/Arbeitsort\s+(.{3,120}?)\s+Kontakt\b/g)]
            .map((x) => x[1])
            .filter((s) => !/Bester|Stellentitel|Aktualit/.test(s));
          if (locs.length) rec.location = locs[0];
        } else {
          notes.push(`profile HTTP ${r.status}`);
        }
      } catch (e) {
        notes.push(`profile read failed: ${String(e?.name || e?.message || e).slice(0, 60)}`);
      }
      records.push(rec);
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url,
      excerpt: `Listed on index page "${page}" as "${matches[0].name}"${matches.length > 1 ? ` (${matches.length} matches)` : ''}${notes.length ? '; ' + notes.join('; ') : ''}`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timedOut ? 'timeout' : 'other', listUrl, String(err?.message || err));
  }
}
