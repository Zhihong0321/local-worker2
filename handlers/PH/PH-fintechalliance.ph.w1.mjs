export const meta = { task: 'PH-fintechalliance.ph', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'role_and_company', 'profile_url'],
  canary: { found: 'Xendit Philippines Inc', not_found: 'Kumpanya Hindi Nakalista Inc' } };

const SITE = 'https://fintechalliance.ph';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'pte', 'pvt',
  'private', 'sdn', 'bhd', 'llc', 'plc', 'gmbh', 'the', 'of']);
const MAX_PROFILES = 12;

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function cleanText(html) {
  return decode((html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** True when the needle tokens appear as one consecutive run inside the hay tokens. */
function hasRun(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

function blocked(text) {
  return /captcha|cf-chl|just a moment|access denied|verify you are human/i.test(text);
}

async function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Read one member profile: its name and its company line (the line under the name, before "Website:"). */
function parseProfile(html, url) {
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const name = h2 ? cleanText(h2[1]) : '';
  let roleLine = '';
  const after = h2 ? html.slice(h2.index + h2[0].length).match(/^\s*<p[^>]*>([\s\S]*?)<\/p>/i) : null;
  if (after) {
    const line = cleanText(after[1]).split(/Website:/i)[0].trim();
    if (line && line.length <= 300) roleLine = line;
  }
  return { name, roleLine, url, text: cleanText(html) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const core = tokens(keyword).filter((t) => !LEGAL.has(t));
  const wanted = core.length ? core : tokens(keyword);
  const searchUrl = `${SITE}/?s=${encodeURIComponent(wanted.join(' '))}`;
  try {
    if (!wanted.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
    }

    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (blocked(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 200) };
    }
    if (!/You searched for|Search Results/i.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const links = [];
    for (const m of html.matchAll(/href="([^"]*\/Member\/[^"#?]+)"/gi)) {
      const href = new URL(decode(m[1]), SITE).href.replace(/\/?$/, '/');
      if (!links.includes(href)) links.push(href);
    }
    if (links.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `Site search for "${wanted.join(' ')}" returned 0 member profiles` };
    }

    const picked = links.slice(0, MAX_PROFILES);
    const pages = await Promise.all(picked.map(async (url) => {
      try {
        const r = await get(url);
        if (!r.ok) return { url, error: `HTTP ${r.status}` };
        return parseProfile(await r.text(), url);
      } catch (e) {
        return { url, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
      }
    }));

    const ok = pages.filter((p) => !p.error);
    if (ok.length === 0) {
      const timeouts = pages.some((p) => p.error === 'timeout');
      return { status: 'couldnt_check', reason: timeouts ? 'timeout' : 'http_error', records: [], source_url: searchUrl,
        excerpt: pages.map((p) => `${p.url} ${p.error}`).join('; ').slice(0, 400) };
    }

    const matches = ok.filter((p) => p.roleLine && hasRun(tokens(p.roleLine), wanted));
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((p) => ({ name: p.name, role_and_company: p.roleLine, profile_url: p.url })),
        source_url: searchUrl,
        excerpt: matches.map((p) => `${p.name} | ${p.roleLine}`).join(' || ').slice(0, 500),
      };
    }

    // The name is in some profile's text but not in a company line: a person has to read it.
    const mentioned = ok.find((p) => hasRun(tokens(p.text), wanted));
    if (mentioned) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: mentioned.url,
        excerpt: `the name appears in a member profile text but not in its company line: ${mentioned.name}` };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `Site search for "${wanted.join(' ')}" returned ${links.length} member profile(s); none has this company in its company line`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
