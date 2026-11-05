export const meta = {
  task: 'SG-idcs.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'firm or project name',
  fields: ['firm', 'category', 'project', 'award'],
  canary: {
    found: 'DP Design',
    not_found: 'Space Factor',
  },
};

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unescape(str) {
  return (str || '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'");
}

/** Look one interior design firm or project up in IDCS 2025 I-DEA gallery. */
export default async function lookup(keyword) {
  const normKw = normalize(keyword);
  const sourceUrl = 'https://idcs.sg/dea2025/gallery/idea/';

  if (!normKw) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: '',
    };
  }

  try {
    const res = await fetch(sourceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const html = await res.text();
    if (!html.includes('I-DEA Winners Gallery') && !html.includes('idcs.sg')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const matches = [];
    const captions = [...html.matchAll(/data-caption="([^"]+)"/g)];
    let firstExcerpt = '';

    for (const m of captions) {
      const cap = unescape(m[1]);
      const cat = cap.match(/<div class="award-cat">([\s\S]*?)<\/div>/i)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
      const firm = cap.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
      const proj = cap.match(/<div class="text-smaller">([\s\S]*?)<\/div>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
      const awardMatch = cap.match(/<span class="label[^"]*">([\s\S]*?)<\/span>/i);
      const award = awardMatch ? awardMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const normFirm = normalize(firm);
      const normProj = normalize(proj);

      if (
        (normFirm && (normFirm.includes(normKw) || normKw.includes(normFirm))) ||
        (normProj && (normProj.includes(normKw) || normKw.includes(normProj)))
      ) {
        if (!matches.some(x => x.firm === firm && x.project === proj && x.category === cat)) {
          matches.push({ firm, category: cat, project: proj, award });
          if (!firstExcerpt) {
            firstExcerpt = `${firm} - ${proj} [${cat}]: ${award}`;
          }
        }
      }
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: firstExcerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: '',
    };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'http_error',
      records: [],
      source_url: sourceUrl,
      excerpt: '',
    };
  }
}
