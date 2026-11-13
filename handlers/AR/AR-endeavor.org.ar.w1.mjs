export const meta = { task: 'AR-endeavor.org.ar', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'company_text', 'founder', 'profile_url'],
  canary: { found: 'Globant', not_found: 'Panadería Inexistente Zqxw SRL' } };

// Endeavor's founder directory: one static page, one card per founder, each card names the founder's company.
const LIST_URL = 'https://www.endeavor.org.ar/emprendedores/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words at the end of a name (after accents and punctuation are removed).
const LEGAL_END = /\s(sociedad anonima|sociedad de responsabilidad limitada|s a de c v|s a s|s a u|s a c|s r l|s l|s a|srl|sas|sau|sac|sa|ltd|llc|inc|corp|co)$/;

function normalize(str) {
  let t = (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  let prev;
  do { prev = t; t = t.replace(LEGAL_END, '').trim(); } while (t !== prev);
  return t.replace(/\s+/g, '');
}

function decode(str) {
  return (str || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;|&#038;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normalize(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000)
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const cards = html.match(/<article\b[^>]*class="[^"]*emprendedores[^"]*"[\s\S]*?<\/article>/g) || [];
    if (cards.length === 0) {
      if (/just a moment|challenge-platform|captcha/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: html.slice(0, 200) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
    }

    const entries = [];
    for (const card of cards) {
      const title = card.match(/elementor-post__title[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const excerpt = card.match(/elementor-post__excerpt"[^>]*>([\s\S]*?)<\/div>/);
      if (!title || !excerpt) continue;
      const companyText = cleanText(excerpt[1]);
      if (!companyText) continue;
      entries.push({ founder: cleanText(title[2]), profile_url: new URL(decode(title[1]), LIST_URL).href, companyText });
    }
    if (entries.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: 'cards found but no name/company fields' };
    }

    const records = [];
    for (const e of entries) {
      // A card may name several companies ("OfficeNet y Quasar Ventures"): check the whole text and each part.
      const parts = e.companyText.split(/\s*(?:,|\/|&| y )\s*/i).map((p) => p.trim()).filter(Boolean);
      const candidates = [e.companyText, ...parts];
      const hit = candidates.find((c) => normalize(c) === kw);
      if (hit) {
        records.push({ name: hit, company_text: e.companyText, founder: e.founder, profile_url: e.profile_url });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `Checked ${entries.length} founder entries on the directory: no company named "${keyword}"`
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `${records.length} founder entr${records.length === 1 ? 'y' : 'ies'} list "${records[0].name}": ${records.map((r) => r.founder).join(', ')}`.slice(0, 500)
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300)
    };
  }
}
