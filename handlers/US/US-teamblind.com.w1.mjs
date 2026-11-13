export const meta = { task: 'US-teamblind.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'employee_rating', 'review_count', 'page_title', 'blind_url'],
  canary: { found: 'Google', not_found: 'Zqxvwpl Nonexistent Holdings' } };

// Blind has one public company page per company: https://www.teamblind.com/company/<Name>/reviews
// A name with no company page answers 404 ("Blind - Anonymous and Professional Community").
// The company page shows its own name (in the <title>) and its employee rating and review count.

const BASE = 'https://www.teamblind.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// The same request headers a desktop Chrome sends for a page visit (plain UA alone gets a 403 block page).
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua-mobile': '?0',
};

const LEGAL_FORMS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'lp', 'llp', 'pllc', 'gmbh', 'sa', 'ag', 'bv', 'pty', 'pte']);
const DOMAIN_TOKENS = new Set(['com', 'net', 'org', 'io']);

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function decodeEntities(str) {
  return (str || '')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Company name as the slug candidates to try, most complete first. */
function slugCandidates(keyword) {
  let words = (keyword || '').replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1].toLowerCase().replace(/\./g, ''))) words.pop();
  const first = words.join(' ');
  const out = [];
  if (first) out.push(first);
  // "Amazon.com, Inc." -> "Amazon.com" has no page; the company is "Amazon".
  const lastWord = (words[words.length - 1] || '').toLowerCase();
  const dot = lastWord.lastIndexOf('.');
  if (dot > 0 && DOMAIN_TOKENS.has(lastWord.slice(dot + 1))) {
    const bare = [...words.slice(0, -1), words[words.length - 1].slice(0, dot)].join(' ');
    if (bare && !out.includes(bare)) out.push(bare);
  }
  return out;
}

function companyUrl(slug) {
  return `${BASE}/company/${encodeURIComponent(slug)}/reviews`;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let lastUrl = '';
  try {
    const candidates = slugCandidates(keyword);
    if (!candidates.length) {
      return { status: 'not_found', reason: '', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    for (let i = 0; i < candidates.length; i++) {
      // Stay well inside the 60 s limit: do not start another fetch once 30 s have passed.
      if (i > 0 && Date.now() - started > 30000) break;
      const slug = candidates[i];
      lastUrl = companyUrl(slug);
      const res = await fetch(lastUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: lastUrl, excerpt: `HTTP ${res.status}` };
      }
      if (res.status === 404) {
        await res.text(); // read the body so the socket is released before the next candidate or exit
        continue; // no company page under this name; try the next candidate
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: lastUrl, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();
      const titleMatch = html.match(/<title>([^<]*?)\s+Company Reviews\b/i);
      if (!titleMatch) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: lastUrl,
          excerpt: decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).slice(0, 300) };
      }

      const siteName = decodeEntities(titleMatch[1]);
      const nameOk = normalize(siteName) === normalize(slug) || normalize(siteName) === normalize(keyword);
      if (!nameOk) {
        // A page exists under a similar name only. Not the same company as far as the site shows: do not claim it.
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
          excerpt: `Blind company page is "${siteName}", not matching "${keyword}"` };
      }

      const ratingMatch = html.match(/has an employee rating of ([\d.]+) out of 5 stars, based on ([\d,]+) company reviews/i);
      const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
      const record = {
        name: siteName,
        employee_rating: ratingMatch ? ratingMatch[1] : '',
        review_count: ratingMatch ? ratingMatch[2].replace(/,/g, '') : '',
        page_title: decodeEntities(html.match(/<title>([^<]*)<\/title>/i)?.[1] || ''),
        blind_url: lastUrl,
      };
      return {
        status: 'found',
        reason: '',
        records: [record],
        source_url: lastUrl,
        excerpt: ratingMatch ? ratingMatch[0] : text.slice(0, 300),
      };
    }

    // Every candidate name answered 404: the site has no company page for this name.
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `Blind has no company page for ${candidates.join(' / ')} (HTTP 404)`,
    };
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: aborted ? 'timeout' : 'other',
      records: [],
      source_url: lastUrl || BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
