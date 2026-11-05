export const meta = {
  task: 'MY-shopify.com',
  want: 'w1',
  tier: 2,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'handle', 'url', 'summary'],
  canary: { found: 'Orius Digital', not_found: 'YYC Advisors' },
};

function parseCards(html) {
  const cardRegex = /<a\s+href="(\/partners\/directory\/partner\/([^"]+))"[\s\S]*?<\/a>/gi;
  const cards = [];
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const cardHtml = match[0];
    const url = 'https://www.shopify.com' + match[1];
    const handle = match[2];
    const nameMatch = cardHtml.match(/alt="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : handle;
    const textOnly = cardHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    cards.push({ name, handle, url, summary: textOnly });
  }
  return cards;
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const term = normalize(keyword);
    if (!term) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://www.shopify.com/partners/directory/locations/malaysia',
        excerpt: 'Empty search keyword',
      };
    }

    const pages = [
      'https://www.shopify.com/partners/directory/locations/malaysia',
      'https://www.shopify.com/partners/directory/locations/malaysia?page=2'
    ];

    let allCards = [];
    let matchedCard = null;
    let matchedPageUrl = pages[0];

    for (let i = 0; i < pages.length; i++) {
      const pageUrl = pages[i];
      if (i > 0) {
        await new Promise(r => setTimeout(r, 1000));
      }

      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!res.ok) {
        return {
          status: 'couldnt_check',
          reason: res.status === 429 ? 'blocked' : 'http_error',
          records: [],
          source_url: pageUrl,
          excerpt: `HTTP status ${res.status}`,
        };
      }

      const html = await res.text();
      if (!html.includes('/partners/directory/partner/')) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: pageUrl,
          excerpt: html.slice(0, 300),
        };
      }

      const cards = parseCards(html);
      allCards = allCards.concat(cards);

      for (const card of cards) {
        const normName = normalize(card.name);
        const normHandle = normalize(card.handle);
        const normSummary = normalize(card.summary);

        if (
          normName.includes(term) ||
          term.includes(normName) ||
          normHandle.includes(term) ||
          term.includes(normHandle) ||
          normSummary.includes(term)
        ) {
          matchedCard = card;
          matchedPageUrl = pageUrl;
          break;
        }
      }

      if (matchedCard) {
        break;
      }
    }

    if (matchedCard) {
      return {
        status: 'found',
        reason: '',
        records: [matchedCard],
        source_url: matchedCard.url || matchedPageUrl,
        excerpt: matchedCard.summary.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pages[0],
      excerpt: `Searched 2 pages (${allCards.length} partners in Malaysia directory); no match for ${keyword}.`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.shopify.com/partners/directory/locations/malaysia',
      excerpt: err.message || String(err),
    };
  }
}
