export const meta = {
  task: 'NZ-masterbuilder.org.nz',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'trading_as', 'member_since', 'branch'],
  canary: { found: 'A E Crane Limited', not_found: 'Kauri Tāwhiri Limited' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 'https://www.masterbuilder.org.nz/RMBA/Check_your_Builder.aspx';
const TEXTBOX = 'ctl01$TemplateBody$WebPartManager1$gwpciCheckyourbuilder$ciCheckyourbuilder$ResultsGrid$Sheet0$Input0$TextBox1';
const SUBMIT = 'ctl01$TemplateBody$WebPartManager1$gwpciCheckyourbuilder$ciCheckyourbuilder$ResultsGrid$Sheet0$SubmitButton';
const LEGAL = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co']);

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"', 'i'));
  return m ? m[1] : null;
}

/** Hidden ASP.NET fields (__VIEWSTATE and friends) from the search page, as a Map. */
function hiddenFields(html) {
  const map = new Map();
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    if (!/type="hidden"/i.test(tag)) continue;
    const name = attr(tag, 'name');
    if (name) map.set(name, decodeEntities(attr(tag, 'value') || ''));
  }
  return map;
}

/** Name key: accents and punctuation removed, trailing legal-form words dropped. */
function nameKey(str) {
  const words = (str || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** Search term: the name as typed, without a trailing legal form (the site lists both "Ltd" and "Limited"). */
function searchTerm(keyword) {
  const words = keyword.trim().split(/\s+/);
  while (words.length > 1 && LEGAL.has(nameKey(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return fail('other', PAGE, 'empty company name');
    const term = searchTerm(name);
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-NZ,en;q=0.9' };

    // Step 1: the search page, to get the session cookie and the ASP.NET hidden fields.
    const getRes = await fetch(PAGE, { headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (getRes.status === 403 || getRes.status === 429) return fail('blocked', PAGE, `HTTP ${getRes.status}`);
    if (!getRes.ok) return fail('http_error', PAGE, `HTTP ${getRes.status}`);
    const getHtml = await getRes.text();
    const fields = hiddenFields(getHtml);
    if (!fields.has('__VIEWSTATE') || !/ciCheckyourbuilder/.test(getHtml)) {
      return fail('layout_changed', PAGE, getHtml.slice(0, 300));
    }
    const setCookies = typeof getRes.headers.getSetCookie === 'function'
      ? getRes.headers.getSetCookie()
      : [getRes.headers.get('set-cookie')].filter(Boolean);
    const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');

    // Step 2: post the search the way the page's own Find button does.
    fields.set('__EVENTTARGET', SUBMIT);
    fields.set('__EVENTARGUMENT', '');
    fields.set(TEXTBOX, term);
    const body = new URLSearchParams([...fields.entries()]).toString();
    const postRes = await fetch(PAGE, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.masterbuilder.org.nz',
        'Referer': PAGE,
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) return fail('blocked', PAGE, `HTTP ${postRes.status}`);
    if (!postRes.ok) return fail('http_error', PAGE, `HTTP ${postRes.status}`);
    const html = await postRes.text();

    const blocks = html.split(/<div class="MBNZ_ProfilePreview">/).slice(1);
    if (blocks.length === 0) {
      if (/There are no records\./i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: `"${term}": There are no records.` };
      }
      if (/captcha|robot|access denied|are you a human/i.test(html)) return fail('blocked', PAGE, cleanText(html).slice(0, 300));
      return fail('layout_changed', PAGE, cleanText(html).slice(0, 300));
    }

    const rows = blocks.map((b) => {
      const pick = (re) => { const m = b.match(re); return m ? cleanText(m[1]) : ''; };
      return {
        name: pick(/<h1>([\s\S]*?)<\/h1>/i),
        trading_as: pick(/Trading as:\s*<strong>([\s\S]*?)<\/strong>/i),
        member_since: pick(/Member Since:\s*<strong>([\s\S]*?)<\/strong>/i),
        branch: pick(/Branch:\s*<strong>([\s\S]*?)<\/strong>/i),
      };
    });

    const pager = html.match(/Item\s*<strong>\d+<\/strong>\s*to\s*<strong>\d+<\/strong>\s*of\s*<strong>(\d+)<\/strong>/i);
    const total = pager ? Number(pager[1]) : rows.length;
    const truncated = total > rows.length;

    const want = nameKey(name);
    const matches = rows.filter((r) => nameKey(r.name) === want || nameKey(r.trading_as) === want);

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: PAGE,
        excerpt: matches.map((r) => `${r.name} | Trading as: ${r.trading_as} | Member Since: ${r.member_since} | Branch: ${r.branch}`).join(' || ').slice(0, 500),
      };
    }
    if (truncated) {
      return fail('other', PAGE, `"${term}" has ${total} results; only the first ${rows.length} are on the page, no exact match among them`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `"${term}": ${rows.length} result(s), none with this company name`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', PAGE, String(err?.message || err));
  }
}
