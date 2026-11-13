export const meta = {
  task: 'AE-sheraa.ae',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'description', 'sector', 'who_they_serve', 'led', 'website'],
  canary: { found: 'Arabee', not_found: 'شركة الواحة الزرقاء للتجارة العامة' },
};

const BASE = 'https://www.sheraa.ae/meet-our-startups';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words. They are dropped from the END of a company name before comparing, on both sides.
const LEGAL = new Set([
  'llc', 'fz', 'fzllc', 'fze', 'fzco', 'fzc', 'ltd', 'limited', 'dmcc', 'pjsc', 'psc', 'llp', 'inc', 'corp', 'co',
  'spc', 'sdn', 'bhd', 'pte', 'plc', 'gmbh', 'saog', 'sole', 'proprietorship',
  'ذ', 'م', 'ش', 'ع',
]);

function words(s) {
  return String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Lower-case, strip accents and tatweel, unify common Arabic letter forms.
function key(w) {
  return w.normalize('NFKD').replace(/\p{Mn}|ـ/gu, '').toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
}

function coreWords(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL.has(key(w[w.length - 1]))) w.pop();
  return w;
}

function normName(s) {
  return coreWords(s).map(key).join(' ');
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function parseCards(html) {
  const parts = html.split('os-sec-card os-sec-card-show-hide').slice(1);
  return parts.map((raw) => {
    const part = raw.split('</section>')[0];
    const nameM = part.match(/class="startup-name">([\s\S]*?)<\/h5>/);
    if (!nameM) return null;
    const descM = part.match(/class="startup-description">([\s\S]*?)<\/p>/);
    const info = {};
    for (const m of part.matchAll(/<span class="os-info-label">([\s\S]*?)<\/span>\s*<span class="os-info-value">([\s\S]*?)<\/span>/g)) {
      info[decode(m[1])] = decode(m[2]);
    }
    const led = [...part.matchAll(/class="os-led-label">([\s\S]*?)<\/span>/g)].map((m) => decode(m[1]));
    const webM = part.match(/<a href="([^"]*)" class="btn-slide-wt"/);
    return {
      name: decode(nameM[1]),
      description: descM ? decode(descM[1]) : '',
      sector: info['Sector'] || '',
      who_they_serve: info['Who they serve'] || '',
      led,
      website: webM ? webM[1].trim() : '',
    };
  });
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = BASE;
  try {
    const core = coreWords(keyword);
    if (!core.length) return out('couldnt_check', 'other', [], BASE, 'empty company name');

    const q = core.join(' ');
    searchUrl = `${BASE}?search=${encodeURIComponent(q)}`;

    let res;
    try {
      res = await fetch(searchUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return out('couldnt_check', timeout ? 'timeout' : 'other', [], searchUrl, String(e?.message || e));
    }

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return out('couldnt_check', 'blocked', [], searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return out('couldnt_check', 'http_error', [], searchUrl, `HTTP ${res.status}`);
    }

    const html = await res.text();
    if (/captcha|challenge-platform|cf-chl|just a moment/i.test(html)) {
      return out('couldnt_check', 'blocked', [], searchUrl, 'bot or captcha check page');
    }
    // The normal page always has the startup section and the search form, with or without results.
    if (!html.includes('class="our-startup-sec"') || !html.includes('name="search"')) {
      return out('couldnt_check', 'layout_changed', [], searchUrl, html.slice(0, 300));
    }

    const cardCount = (html.match(/class="startup-name"/g) || []).length;
    const cards = parseCards(html);
    if (cards.length !== cardCount || cards.some((c) => c === null)) {
      return out('couldnt_check', 'layout_changed', [], searchUrl, 'startup cards not in the expected form');
    }
    const list = cards.filter(Boolean);

    const want = normName(keyword);
    const matches = list.filter((c) => normName(c.name) === want);

    if (!matches.length) {
      return out('not_found', '', [], searchUrl,
        `Sheraa search for "${q}" returned ${list.length} startup(s); none has this name`);
    }

    return out('found', '', matches, searchUrl, matches[0].description || matches[0].name);
  } catch (err) {
    return out('couldnt_check', 'other', [], searchUrl, String(err?.message || err));
  }
}
