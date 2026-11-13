export const meta = { task: 'IN-assocham.org', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'site_id', 'list', 'logo'], canary: { found: 'Zaggle', not_found: 'कल्पना उद्योग प्राइवेट लिमिटेड' } };

// The ASSOCHAM home page calls this JSON endpoint for its "Key Members" logo wall. It holds ~230 names only,
// not the full membership (the site claims 4,50,000 members, but publishes no searchable directory).
const ENDPOINT = 'https://www.assocham.org/assocham_backend/api/get-keymember.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'plc', 'public', 'company', 'co', 'opc', 'inc']);
const LOGO_NOISE = new Set(['logo', 'logos', 'original', 'rgb', 'bg', 'white', 'png', 'jpg', 'jpeg']);

/** Normalised key: lower case, letters and digits only, no legal form words, no logo-file words. */
function key(str) {
  return String(str || '').normalize('NFKC').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL.has(t) && !LOGO_NOISE.has(t)).join('');
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: ENDPOINT, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = key(keyword);
    if (!want) return couldnt('other', 'the company name has no letters or digits to match');

    const res = await fetch(ENDPOINT, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|access denied|are you a robot/i.test(text)) return couldnt('blocked', 'bot check page');
    let body;
    try { body = JSON.parse(text); } catch { return couldnt('layout_changed', 'response is not JSON'); }
    if (!body || body.success !== true || !Array.isArray(body.data) || body.data.length === 0) {
      return couldnt('layout_changed', 'unexpected key-member response: ' + text.slice(0, 200));
    }

    const hits = body.data.filter((x) => x && (key(x.name) === want || key(x.tag) === want));
    if (hits.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: ENDPOINT,
        excerpt: `Not in the ASSOCHAM key-members list (${body.data.length} names). This list is not a full membership directory.`,
      };
    }
    return {
      status: 'found', reason: '',
      records: hits.map((x) => ({ name: x.name, site_id: x.id, list: 'ASSOCHAM key members (home page logo wall)', logo: x.img || '' })),
      source_url: ENDPOINT,
      excerpt: `Listed as key member: "${hits[0].name}" (site id ${hits[0].id})`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', String(err?.message || err));
  }
}
