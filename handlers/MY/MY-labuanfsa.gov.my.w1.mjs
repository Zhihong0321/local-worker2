export const meta = { task: 'MY-labuanfsa.gov.my', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'registration_no', 'status', 'entity_type', 'register_type', 'registration_date', 'deregistration_date', 'registered_office'],
  canary: { found: 'ACE Investment Bank Limited', not_found: 'Syarikat Tidak Wujud Sdn Bhd' } };

// The Labuan FSA site (www.labuanfsa.gov.my) links its "Labuan Company Search" to REEFS, the public registry of
// Labuan companies and other entities. REEFS checks an exact entity name (or entity number) with one POST.
const PAGE = 'https://coral2.labuanfsa.gov.my/reefs';
const VALIDATE = 'https://coral2.labuanfsa.gov.my/validate-entity-reefs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TOTAL_MS = 50000; // stay well under the 60 s limit

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

// Keeps the session cookies the site sets (Laravel session + XSRF), as a browser would.
function absorbCookies(res, jar) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const combined = raw.filter(Boolean).join(', ');
  for (const m of combined.matchAll(/(?:^|,\s*)([^=;,\s]+)=([^;,]*)/g)) jar.set(m[1], m[2]);
}

async function call(url, init, deadline, jar) {
  const left = deadline - Date.now();
  if (left < 2000) throw Object.assign(new Error('time budget used up'), { name: 'TimeoutError' });
  const headers = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(init.headers || {}) };
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(Math.min(25000, left)) });
  absorbCookies(res, jar);
  return res;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + TOTAL_MS;
  const typed = String(keyword || '').trim().replace(/\s+/g, ' ');
  if (!typed) return failure('other', PAGE, 'empty company name');
  const jar = new Map();
  try {
    // 1. Open the search page: gives the CSRF token and the session cookies.
    const page = await call(PAGE, {}, deadline, jar);
    const pageHtml = await page.text();
    if (page.status === 403 || page.status === 429) return failure('blocked', PAGE, `HTTP ${page.status}`);
    if (!page.ok) return failure('http_error', PAGE, `HTTP ${page.status}`);
    const tok = /<meta name="csrf-token" content="([^"]+)"/.exec(pageHtml);
    if (!tok) return failure(/captcha|cloudflare|login/i.test(pageHtml) ? 'blocked' : 'layout_changed', PAGE, pageHtml.slice(0, 300));
    const csrf = tok[1];

    // 2. Ask for the name as typed. REEFS matches the exact spelling, so also try the common casings.
    const variants = [...new Set([typed, typed.toUpperCase(), typed.toLowerCase(), titleCase(typed)])];
    for (const name of variants) {
      const res = await call(VALIDATE, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          accept: 'application/json, text/javascript, */*; q=0.01',
          'x-requested-with': 'XMLHttpRequest',
          'x-csrf-token': csrf,
          origin: 'https://coral2.labuanfsa.gov.my',
          referer: PAGE,
        },
        body: new URLSearchParams({ entity_number: '', entity_name: name }).toString(),
      }, deadline, jar);
      const text = await res.text();
      if (res.status === 403 || res.status === 429) return failure('blocked', VALIDATE, `HTTP ${res.status}`);
      if (!res.ok) return failure('http_error', VALIDATE, `HTTP ${res.status}`);

      let body;
      try { body = JSON.parse(text); } catch {
        return failure(/captcha|cloudflare|login/i.test(text) ? 'blocked' : 'layout_changed', VALIDATE, text.slice(0, 300));
      }

      if (body && body.valid === true) {
        if (normalise(body.entity_name) !== normalise(typed)) {
          return failure('other', PAGE, `registry returned "${body.entity_name}" for "${typed}"`);
        }
        const dash = (v) => (v == null ? '' : String(v));
        return {
          status: 'found',
          reason: '',
          records: [{
            name: dash(body.entity_name),
            registration_no: dash(body.entity_no),
            status: dash(body.entity_status_name),
            entity_type: dash(body.entity_type_name),
            register_type: dash(body.entity_register_type_name),
            registration_date: dash(body.entity_registration_date),
            deregistration_date: dash(body.entity_deregistration_date),
            registered_office: dash(body.registered_office),
          }],
          source_url: PAGE,
          excerpt: `${dash(body.entity_name)} | ${dash(body.entity_no)} | ${dash(body.entity_status_name)} | ${dash(body.entity_register_type_name)}`.slice(0, 300),
        };
      }
      if (body && body.code === 'ENTITY_NOT_FOUND') continue;
      return failure('other', PAGE, `REEFS code ${body && body.code}: ${body && body.message || ''}`);
    }

    // The site answered normally for every spelling and listed nothing.
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `REEFS answered ENTITY_NOT_FOUND for: ${variants.join(' | ')}`,
    };
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return failure('timeout', PAGE, String(err.message || err));
    return failure('other', PAGE, String(err && err.message || err));
  }
}
