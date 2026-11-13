export const meta = { task: 'PH-onlinejobs.ph', want: 'w1', tier: 2, method: 'post', pdf: false, input: 'company name',
  fields: ['name', 'account_upgraded', 'complaints', 'job_posts'],
  canary: { found: 'Kilmarnon Consulting Ltd.', not_found: 'Kumpanyang Walang Pangalan Corp' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 'https://www.onlinejobs.ph/jobseekers/employersearch';
const LEGAL = new Set(['sdn', 'bhd', 'pte', 'pty', 'pvt', 'ltd', 'limited', 'inc', 'llc', 'llp', 'corp', 'corporation', 'co', 'company', 'opc', 'gmbh', 'plc']);

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#x27;|&rsquo;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Compare names: case, accents, punctuation and legal-form words do not count. */
function norm(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').filter((t) => t && !LEGAL.has(t)).join(' ');
}

function result(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!norm(name)) return result('couldnt_check', 'other', [], PAGE, 'empty company name');

    // Step 1: open the search form to get the session cookie and the CSRF token.
    const getRes = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (getRes.status === 403 || getRes.status === 429) return result('couldnt_check', 'blocked', [], PAGE, `HTTP ${getRes.status}`);
    if (!getRes.ok) return result('couldnt_check', 'http_error', [], PAGE, `HTTP ${getRes.status}`);
    const getHtml = await getRes.text();
    const tok = getHtml.match(/name="csrf-token" value="([0-9a-f]+)"/i);
    if (!tok) {
      const blocked = /Just a moment|cf-chl|captcha/i.test(getHtml);
      return result('couldnt_check', blocked ? 'blocked' : 'layout_changed', [], PAGE, clean(getHtml).slice(0, 300));
    }
    const cookies = (getRes.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter(Boolean).join('; ');

    // Step 2: post the search.
    const body = new URLSearchParams({ 'csrf-token': tok[1], 'search': name });
    const postRes = await fetch(PAGE + '/', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': PAGE,
        ...(cookies ? { 'Cookie': cookies } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) return result('couldnt_check', 'blocked', [], PAGE, `HTTP ${postRes.status}`);
    if (!postRes.ok) return result('couldnt_check', 'http_error', [], PAGE, `HTTP ${postRes.status}`);
    const html = await postRes.text();
    const text = clean(html);

    // Found: the site writes the name back. An exact match shows the full name; a partial match is masked with '*'.
    const shownM = html.match(/We have found\s*<strong>([\s\S]*?)<\/strong>/i);
    if (shownM) {
      const shown = clean(shownM[1]);
      const after = text.slice(text.indexOf('We have found'));
      const excerpt = after.split('Job Posts')[0].slice(0, 500);
      const sameName = !shown.includes('*') && norm(shown) !== '' && norm(shown) === norm(name);
      if (!sameName) {
        return result('not_found', '', [], PAGE, `Site shows only a different or partial match: "${shown}"`);
      }
      const jobs = /There are no jobs posted/i.test(text) ? 'none posted' : 'see page';
      return result('found', '', [{
        name: shown,
        account_upgraded: (text.match(/in our system, (.{1,200}?)\. You can tell/i) || [])[1] || 'see page',
        complaints: /No complaints have been received/i.test(text) ? 'none received' : 'see page',
        job_posts: jobs,
      }], PAGE, excerpt);
    }

    // Not found: the site answered normally and says the name is not in its system.
    if (/is not found in our system/i.test(text) && /That name/i.test(text)) {
      const m = text.match(/That name (.{1,200}?) is not found in our system/i);
      return result('not_found', '', [], PAGE, m ? `That name ${m[1]} is not found in our system` : 'That name ... is not found in our system');
    }

    return result('couldnt_check', 'layout_changed', [], PAGE, text.slice(0, 300));
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return result('couldnt_check', timeout ? 'timeout' : 'other', [], PAGE, String(err?.message || err));
  }
}
