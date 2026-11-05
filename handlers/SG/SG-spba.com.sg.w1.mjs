export const meta = {
  task: 'SG-spba.com.sg',
  want: 'w1',
  tier: 2,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'year', 'category'],
  canary: {
    found: 'Blue Cube Media',
    not_found: 'OOm Pte Ltd',
  },
};

const PAGES = [
  { year: '2025', url: 'https://www.spba.com.sg/spba-2024-winners-copy/' },
  { year: '2024', url: 'https://www.spba.com.sg/spba-2024-winners/' },
  { year: '2023', url: 'https://www.spba.com.sg/spba-2023-winners/' },
  { year: '2020/21', url: 'https://www.spba.com.sg/spba-2020-21-winners/' },
  { year: '2019', url: 'https://www.spba.com.sg/spba-2019-20-winners/' },
];

let lastRequestTime = 0;
let cachedWinners = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeFetch(url) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1050) {
    await sleep(1050 - elapsed);
  }
  lastRequestTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function normalize(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '-')
    .replace(/&#038;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\b(pte\.?|ltd\.?|private|limited|llc|inc|corp|corporation)\b/gi, ' ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(query, candidate) {
  const qNorm = normalize(query);
  const cNorm = normalize(candidate);
  if (!qNorm || !cNorm) return false;
  if (qNorm === cNorm) return true;

  const qNoSg = qNorm.replace(/\bsingapore\b/g, '').replace(/\s+/g, ' ').trim();
  const cNoSg = cNorm.replace(/\bsingapore\b/g, '').replace(/\s+/g, ' ').trim();
  if (qNoSg && cNoSg && qNoSg === cNoSg) return true;

  const qWords = qNorm.split(' ');
  const cWords = cNorm.split(' ');
  if (qWords.length >= 2 && cWords.length >= 2) {
    if (qWords.every((w) => cWords.includes(w)) || cWords.every((w) => qWords.includes(w))) {
      return true;
    }
  }

  return false;
}

async function loadAllWinners() {
  if (cachedWinners) return { ok: true, data: cachedWinners };

  const winners = [];
  for (const page of PAGES) {
    let res;
    try {
      res = await politeFetch(page.url);
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || /timeout/i.test(String(err));
      return {
        ok: false,
        status: 'couldnt_check',
        reason: isTimeout ? 'timeout' : 'http_error',
        source_url: page.url,
        excerpt: String(err).slice(0, 500),
      };
    }

    if (res.status === 403 || res.status === 429) {
      return {
        ok: false,
        status: 'couldnt_check',
        reason: 'blocked',
        source_url: page.url,
        excerpt: 'HTTP ' + res.status + ' response from server',
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: 'couldnt_check',
        reason: 'http_error',
        source_url: page.url,
        excerpt: 'HTTP ' + res.status + ' on ' + page.url,
      };
    }

    const html = await res.text();

    if (/challenge-running|cf-turnstile|captcha|waf/i.test(html)) {
      return {
        ok: false,
        status: 'couldnt_check',
        reason: 'blocked',
        source_url: page.url,
        excerpt: 'Bot challenge detected on page',
      };
    }

    const titleCheckRegex = /<h\d[^>]*class=\"[^\"]*uabb-infobox-title[^\"]*\"[^>]*>/i;
    if (!titleCheckRegex.test(html)) {
      return {
        ok: false,
        status: 'couldnt_check',
        reason: 'layout_changed',
        source_url: page.url,
        excerpt: 'Expected uabb-infobox-title marker not found on ' + page.url,
      };
    }

    const blockRegex =
      /<h\d[^>]*class=\"[^\"]*uabb-infobox-title[^\"]*\"[^>]*>([\s\S]*?)<\/h\d>[\s\S]*?<div class=\"[^\"]*uabb-infobox-text[^\"]*\"[^>]*>([\s\S]*?)<\/div>/gi;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(html)) !== null) {
      const blockTitle = blockMatch[1].replace(/<[^>]+>/g, '').trim();
      const blockBody = blockMatch[2];

      let cat = blockTitle;
      const catMatch = blockTitle.match(/-\s*([^<]+)$/);
      if (catMatch) {
        cat = catMatch[1].trim();
      }

      const rawItems = blockBody.split(/<br\s*\/?>|<\/p>|<\/li>/i);
      for (const raw of rawItems) {
        const clean = raw
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&#8211;/g, '-')
          .replace(/&#038;/g, '&')
          .replace(/&nbsp;/g, ' ')
          .replace(/&quot;/g, '\"')
          .trim();
        if (!clean) continue;

        let name = clean.replace(/^\d+\.\s*/, '').trim();
        let subAward = '';
        const subAwardMatch = name.match(/^(Most Popular [^:]+|Overall Winner):\s*(.*)$/i);
        if (subAwardMatch) {
          subAward = subAwardMatch[1].trim();
          name = subAwardMatch[2].trim();
        }

        winners.push({
          name,
          year: page.year,
          category: subAward ? cat + ' (' + subAward + ')' : cat,
          source_url: page.url,
          excerpt: clean + ' (' + blockTitle + ')',
        });
      }
    }
  }

  cachedWinners = winners;
  return { ok: true, data: winners };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGES[0].url,
        excerpt: '',
      };
    }

    const loaded = await loadAllWinners();
    if (!loaded.ok) {
      return {
        status: loaded.status,
        reason: loaded.reason,
        records: [],
        source_url: loaded.source_url,
        excerpt: loaded.excerpt,
      };
    }

    const winners = loaded.data;
    const records = [];
    const seen = new Set();
    let matchedSourceUrl = '';
    let matchedExcerpt = '';

    for (const w of winners) {
      if (matches(keyword, w.name)) {
        const dedupKey = w.name.toLowerCase() + '|' + w.year + '|' + w.category.toLowerCase();
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          records.push({
            name: w.name,
            year: w.year,
            category: w.category,
          });
          if (!matchedSourceUrl) {
            matchedSourceUrl = w.source_url;
            matchedExcerpt = w.excerpt;
          }
        }
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchedSourceUrl,
        excerpt: matchedExcerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGES[0].url,
      excerpt: '',
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: PAGES[0].url,
      excerpt: String(err).slice(0, 500),
    };
  }
}