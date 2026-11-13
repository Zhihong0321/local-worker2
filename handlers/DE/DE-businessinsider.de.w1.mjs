export const meta = { task: 'DE-businessinsider.de', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'topic_url', 'description', 'headlines'],
  canary: { found: 'Personio', not_found: 'Bäckerei Zimmermann Probst Hofladen GmbH' } };

const BASE = 'https://www.businessinsider.de/themen/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_TOKENS = new Set(['gmbh', 'mbh', 'ag', 'se', 'ug', 'kg', 'kgaa', 'ohg', 'gbr', 'co', 'ev', 'ltd', 'limited',
  'inc', 'llc', 'plc', 'sas', 'sarl', 'bv', 'nv', 'spa', 'srl', 'sa', '&', 'und']);

/** Umlauts and accents to plain ASCII, the way the site writes its topic addresses (ü -> ue, ß -> ss). */
function translit(s) {
  return (s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Company name without its legal form at the end ("ACME GmbH & Co. KG" -> "ACME"). */
function baseName(keyword) {
  const words = (keyword || '').trim().split(/\s+/).filter(Boolean);
  while (words.length && LEGAL_TOKENS.has(translit(words[words.length - 1]).replace(/[.,]/g, ''))) words.pop();
  return words.join(' ');
}

function normName(s) {
  return translit(s).replace(/[^a-z0-9]/g, '');
}

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let topicUrl = '';
  try {
    const name = baseName(keyword);
    const slug = translit(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no usable name in the input' };
    }
    topicUrl = `${BASE}${slug}/`;

    const res = await fetch(topicUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    // The site answers "Page not found" for a name it has no topic page for: that is a normal answer, not a refusal.
    if (res.status === 404) {
      await res.text();
      return { status: 'not_found', reason: '', records: [], source_url: topicUrl, excerpt: `HTTP 404: no topic page for "${name}"` };
    }
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel?.();
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: topicUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      await res.body?.cancel?.();
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: topicUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const finalUrl = res.url || topicUrl;
    const h1 = html.match(/<h1[^>]*class="section-title"[^>]*>([\s\S]*?)<\/h1>/i);

    if (!h1) {
      const bot = /cf-chl|Just a moment|captcha|Zugriff verweigert/i.test(html.slice(0, 20000));
      return { status: 'couldnt_check', reason: bot ? 'blocked' : 'layout_changed', records: [], source_url: finalUrl,
        excerpt: cleanText(html).slice(0, 300) };
    }

    const topicName = cleanText(h1[1]);
    // Match the company, not just similar words: the topic page must be for this name.
    if (normName(topicName) !== normName(name)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: finalUrl,
        excerpt: `topic page is "${topicName}", not "${name}"` };
    }

    const descMatch = html.match(/<div[^>]*class="section-description"[^>]*>([\s\S]*?)<\/div>/i);
    const description = descMatch ? cleanText(descMatch[1]) : '';

    const headlines = [];
    for (const m of html.matchAll(/<h2[^>]*itemprop="headline"[^>]*>([\s\S]*?)<\/h2>/gi)) {
      const t = cleanText(m[1]);
      if (t && !headlines.includes(t)) headlines.push(t);
      if (headlines.length >= 20) break;
    }

    const excerpt = (description || headlines[0] || topicName).slice(0, 500);
    return {
      status: 'found',
      reason: '',
      records: [{ name: topicName, topic_url: finalUrl, description, headlines }],
      source_url: finalUrl,
      excerpt,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: topicUrl || BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
