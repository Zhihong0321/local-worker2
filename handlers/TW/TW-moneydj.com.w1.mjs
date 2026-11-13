export const meta = {
  task: 'TW-moneydj.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'stock_code', 'phone', 'address', 'founded', 'listed_date'],
  canary: { found: '台積電', not_found: '不存在科技' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIST_URL = 'https://www.moneydj.com/z/js/vipasp.djjs?a=3';
const profileUrl = (code) => `https://www.moneydj.com/z/zc/zca/zca_${code}.djhtm`;

// Legal-form words that a Taiwanese or English company name may carry.
const LEGAL_FORMS = /(股份有限公司|有限公司|股份有限|公司|\bco\b|\bltd\b|\blimited\b|\binc\b|\bcorp\b|\bcorporation\b|\bcompany\b|\bllc\b)/g;

/** Returns the name core (legal form removed, case/space/punctuation removed) and whether a legal form was present. */
function coreName(raw) {
  let legal = false;
  const s = (raw || '').normalize('NFKC').toLowerCase().replace(LEGAL_FORMS, () => { legal = true; return ' '; });
  const core = s.replace(/[\s.,，。、()（）\-_&'"/]/g, '');
  return { core, legal };
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Reads the value cell that follows a label cell such as <td class="t4t1">公司地址</td><td ...>VALUE</td>.
function profileField(html, label) {
  const safe = label.replace(/[()]/g, '\\$&');
  const m = html.match(new RegExp(`<td[^>]*>\\s*${safe}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
  return m ? cleanText(m[1]) : '';
}

async function fetchBig5(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
    signal: AbortSignal.timeout(25000),
  });
  return { res, text: res.ok ? new TextDecoder('big5').decode(await res.arrayBuffer()) : '' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const { core, legal } = coreName(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    // Step 1: the site's full stock list (code,name pairs), decoded from Big5.
    const { res, text } = await fetchBig5(LIST_URL);
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!text.includes('gsStock')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: text.slice(0, 200) };
    }

    const entries = [];
    const body = text.slice(text.indexOf("'") + 1);
    for (const item of body.split(';')) {
      const parts = item.replace(/'/g, '').trim().split(',');
      if (parts.length < 3) continue;
      const code = parts[1].trim();
      const name = parts.slice(2).join(',').trim();
      if (/^\d{4}$/.test(code) && name) entries.push({ code, name });
    }
    if (entries.length < 100) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: `only ${entries.length} entries parsed` };
    }

    // Step 2: exact match on the normalised short name the site writes.
    const matches = entries.filter((e) => coreName(e.name).core === core);
    if (matches.length === 0) {
      if (legal) {
        // The site lists short trading names only, so a legal name that differs from them cannot be shown absent.
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
          excerpt: `No listed short name equals "${core}". The site lists short names only, so the company cannot be confirmed absent.`,
        };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No listed name equals "${core}" among ${entries.length} stock-list entries`,
      };
    }

    // Step 3: profile page per match (enrichment only; a failed profile does not undo the match).
    const records = await Promise.all(matches.map(async (m) => {
      const rec = { name: m.name, stock_code: m.code, phone: '', address: '', founded: '', listed_date: '' };
      try {
        const { res: pr, text: html } = await fetchBig5(profileUrl(m.code));
        if (pr.ok) {
          rec.phone = profileField(html, '公司電話');
          rec.address = profileField(html, '公司地址');
          rec.founded = profileField(html, '成立時間');
          rec.listed_date = profileField(html, '初次上市(櫃)日期');
        }
      } catch {
        // keep the match; enrichment is optional
      }
      return rec;
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: profileUrl(matches[0].code),
      excerpt: `${matches[0].name} (${matches[0].code}) is on the MoneyDJ stock list`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
