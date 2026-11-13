export const meta = { task: 'JP-jvca.jp', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'category', 'language', 'website', 'list_url'],
  canary: { found: '株式会社iSGSインベストメントワークス', not_found: '株式会社ゼロ・ワン・ナンバーテスト' } };

// JVCA publishes its members as plain HTML lists (no search form, no API). Six lists are read:
// VC members, CVC members and supporting members, each in Japanese and in English.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LISTS = [
  { category: 'vc_member', language: 'ja', url: 'https://jvca.jp/members/vc-members' },
  { category: 'cvc_member', language: 'ja', url: 'https://jvca.jp/members/cvc-members' },
  { category: 'supporting_member', language: 'ja', url: 'https://jvca.jp/members/supporting-members' },
  { category: 'vc_member', language: 'en', url: 'https://jvca.jp/members/vc-members-en' },
  { category: 'cvc_member', language: 'en', url: 'https://jvca.jp/members/cvc-members-en' },
  { category: 'supporting_member', language: 'en', url: 'https://jvca.jp/members/supporting-members-en' },
];

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare company names: width, case, punctuation, spaces and legal form are ignored. */
function normalizeName(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  t = t.replace(/[(（]\s*(株|有|同|合資|合名)\s*[)）]/g, ' ');
  t = t.replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|社団法人|財団法人|特定非営利活動法人|有限責任事業組合/g, ' ');
  t = t.replace(/[\p{P}\p{S}\s]+/gu, ' ');
  t = t.replace(/\b(co|inc|ltd|llc|llp|lp|corp|corporation|company|limited|kk|gk|plc)\b/g, ' ');
  return t.replace(/\s+/g, '');
}

/** Read the members of one list page. Returns { entries } or { error }. Never throws. */
async function readList(list) {
  let res;
  try {
    res = await fetch(list.url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': list.language === 'en' ? 'en,ja;q=0.5' : 'ja,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { error: { reason: timedOut ? 'timeout' : 'other', url: list.url, excerpt: String(e?.message || e).slice(0, 200) } };
  }
  if (res.status === 403 || res.status === 429) {
    return { error: { reason: 'blocked', url: list.url, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { error: { reason: 'http_error', url: list.url, excerpt: `HTTP ${res.status}` } };
  }

  let html;
  try {
    html = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { error: { reason: timedOut ? 'timeout' : 'other', url: list.url, excerpt: String(e?.message || e).slice(0, 200) } };
  }

  const block = html.match(/<ul class="members-list">([\s\S]*?)<\/ul>/);
  if (!block) {
    if (/cf-chl|captcha|Attention Required|Access denied/i.test(html)) {
      return { error: { reason: 'blocked', url: list.url, excerpt: html.slice(0, 200) } };
    }
    return { error: { reason: 'layout_changed', url: list.url, excerpt: html.slice(0, 200) } };
  }

  const entries = [];
  for (const chunk of block[1].split(/<li[\s>]/).slice(1)) {
    const title = chunk.match(/<h3 class="title">([\s\S]*?)<\/h3>/);
    const name = title ? cleanText(title[1]) : '';
    if (!name) continue;
    const href = chunk.match(/<a[^>]*\shref="([^"]*)"/);
    const website = href ? decodeEntities(href[1]).trim() : '';
    entries.push({ name, website: /^https?:\/\//i.test(website) ? website : '' });
  }
  if (entries.length === 0) {
    return { error: { reason: 'layout_changed', url: list.url, excerpt: 'members-list has no named entries' } };
  }
  return { entries };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword ?? '').trim();
    const key = normalizeName(name);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LISTS[0].url, excerpt: 'empty company name' };
    }

    const loaded = await Promise.all(LISTS.map(async (list) => ({ list, ...(await readList(list)) })));

    const records = [];
    const seen = new Set();
    let total = 0;
    for (const r of loaded) {
      if (!r.entries) continue;
      total += r.entries.length;
      for (const e of r.entries) {
        if (normalizeName(e.name) !== key) continue;
        const dedupeKey = r.list.category + '|' + key; // same member listed in Japanese and English
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        records.push({ name: e.name, category: r.list.category, language: r.list.language, website: e.website, list_url: r.list.url });
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].list_url,
        excerpt: records.map((r) => `${r.name} (${r.category}, ${r.language})`).join(' | ').slice(0, 500),
      };
    }

    const failed = loaded.filter((r) => r.error);
    if (failed.length > 0) {
      const f = failed[0].error;
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: f.url,
        excerpt: `${f.excerpt}; ${failed.length} of ${LISTS.length} lists could not be read, so absence is not confirmed`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LISTS[0].url,
      excerpt: `Checked ${LISTS.length} JVCA member lists (${total} entries); no member with this name`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LISTS[0].url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
