export const meta = {
  task: 'TH-data.creden.co', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'registration_number', 'name_en', 'name_th'],
  canary: { found: 'CP ALL PUBLIC COMPANY LIMITED', not_found: 'ทดสอบไม่มีอยู่จริงคอมพานี จำกัด' },
};

const ENDPOINT = 'https://data.creden.co/sapi/search/get_suggestion';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words are removed on both sides so "ACME CO., LTD." and "ACME" compare equal.
function core(str) {
  let s = (str || '').toLowerCase();
  s = s.replace(/บริษัท|จำกัด|มหาชน/g, ' ');
  s = s.replace(/\b(public company limited|company limited|co\.?\s*,?\s*ltd\.?|limited|ltd\.?|pcl|plc|public|company|co)\b/g, ' ');
  return s.replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

// The site's prefix search finds nothing when the legal form is in the query ("CP ALL CO., LTD." -> 0),
// so the query uses the name without legal-form words; the full name is still used for the match.
function queryText(text) {
  let s = text.replace(/บริษัท|จำกัด|มหาชน|[()]/g, ' ');
  s = s.replace(/\b(public company limited|company limited|co\.?\s*,?\s*ltd\.?|limited|ltd\.?|pcl|plc|public|company|co)\b/gi, ' ');
  s = s.replace(/[,.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 3 ? s : text;
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const text = String(keyword || '').trim();
  try {
    const query = queryText(text);
    if (query.length < 3) {
      // The site itself refuses queries shorter than 3 characters (HTTP 400 "payload text wrong").
      return fail('couldnt_check', 'other', ENDPOINT, 'keyword shorter than the 3 characters the site search needs');
    }
    const lang = /[฀-๿]/.test(query) ? 'th' : 'en';
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
      body: JSON.stringify({ type_search: 'prefix', text: query, lang }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', ENDPOINT, `HTTP ${res.status}`);
    if (res.status === 400) {
      const body = await res.text();
      return fail('couldnt_check', 'other', ENDPOINT, `HTTP 400 ${body}`);
    }
    if (!res.ok) return fail('couldnt_check', 'http_error', ENDPOINT, `HTTP ${res.status}`);

    const raw = await res.text();
    if (/captcha|challenge|cf-mitigated/i.test(raw.slice(0, 2000))) return fail('couldnt_check', 'blocked', ENDPOINT, raw);

    let json;
    try { json = JSON.parse(raw); } catch { return fail('couldnt_check', 'layout_changed', ENDPOINT, raw); }
    if (json.success !== true || !json.data || typeof json.data !== 'object') {
      return fail('couldnt_check', 'layout_changed', ENDPOINT, raw);
    }

    // The site returns an array of matches, or an empty object {} when nothing matches.
    const result = json.data.result;
    const list = Array.isArray(result) ? result : (result && typeof result === 'object' && Object.keys(result).length === 0 ? [] : null);
    if (list === null) return fail('couldnt_check', 'layout_changed', ENDPOINT, raw);

    const want = core(text);
    const records = [];
    for (const item of list) {
      const en = item?.company_name?.en || '';
      const th = item?.company_name?.th || '';
      if (!item?.id || (!en && !th)) continue;
      if (core(en) === want || core(th) === want) {
        records.push({
          name: en || th,
          registration_number: String(item.id),
          name_en: en,
          name_th: th,
        });
      }
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: ENDPOINT,
               excerpt: `site search returned ${list.length} suggestion(s), none with this name` };
    }
    return { status: 'found', reason: '', records, source_url: ENDPOINT,
             excerpt: records.map(r => `${r.registration_number} ${r.name_en} | ${r.name_th}`).join('; ').slice(0, 300) };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return fail('couldnt_check', reason, ENDPOINT, String(err?.message || err));
  }
}
