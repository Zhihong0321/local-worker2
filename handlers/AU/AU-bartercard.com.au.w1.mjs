export const meta = { task: 'AU-bartercard.com.au', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'outlet_id', 'legal_name', 'abn', 'status', 'categories', 'address', 'web'],
  canary: { found: 'Brew Moon Cafe', not_found: 'Xqzvbnm Nonexistent Trading Pty Ltd' } };

// Bartercard's public member directory (mybc.bartercard.com.au, a Nuxt app) calls this JSON API without a login.
const API = 'https://bcausys.bartercard.com.au/system/api/frontend/marketplace/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};
// Legal forms removed from the end of a name before comparing (longest first is not needed: the loop repeats).
const LEGAL_FORMS = ['proprietary limited', 'pty ltd', 'pty limited', 'pte ltd', 'sdn bhd', 'pty', 'pte', 'bhd', 'ltd',
  'limited', 'incorporated', 'inc', 'llc', 'plc', 'corporation', 'corp', 'company', 'co'];

/** Lower-case, no accents, punctuation as spaces, trailing legal form removed. */
function coreName(name) {
  let s = String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of LEGAL_FORMS) {
      if (s.endsWith(' ' + f) && s.length > f.length + 1) {
        s = s.slice(0, -(f.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s;
}

/** Comparison key: letters and digits only (any script). */
function key(name) {
  return coreName(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function isTimeout(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  if (!input) return fail('couldnt_check', 'other', '', 'empty company name');
  const query = coreName(input);
  const searchUrl = `${API}/search/directory?Search=${encodeURIComponent(query)}`;
  try {
    // Step 1: directory search. The site matches the whole phrase, so the legal form is left out of the query.
    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { return fail('couldnt_check', 'layout_changed', searchUrl, text.slice(0, 300)); }
    if (!body || body.Success !== true || !Array.isArray(body.Data)) {
      return fail('couldnt_check', 'layout_changed', searchUrl, JSON.stringify(body).slice(0, 300));
    }

    // Only member outlets count; the same response also lists categories.
    const outlets = body.Data.filter((x) => x && x.isOutlet === true && x.OutletID);
    const wanted = key(input);
    const matches = outlets.filter((x) => key(x.Name) === wanted);

    const total = Number(body.Pagination && body.Pagination.TotalItems);
    if (!matches.length && Number.isFinite(total) && total > body.Data.length) {
      return fail('couldnt_check', 'other', searchUrl, `search returned ${body.Data.length} of ${total} items; match not confirmed`);
    }
    if (!matches.length) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `Search "${query}" returned ${outlets.length} outlet(s); none matches "${input}"`,
      };
    }

    // Step 2: outlet detail for each exact match (in parallel, so the total time stays under 60 s).
    const records = await Promise.all(matches.slice(0, 5).map(async (m) => {
      const detailUrl = `${API}/outlets/${encodeURIComponent(m.OutletID)}`;
      const rec = { name: m.Name, outlet_id: String(m.OutletID), legal_name: '', abn: '', status: '',
        categories: '', address: '', web: '', detail_source: detailUrl, detail_error: '' };
      try {
        const r = await fetch(detailUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (!r.ok) { rec.detail_error = `HTTP ${r.status}`; return rec; }
        const o = (JSON.parse(await r.text()) || {}).Data;
        if (!o) { rec.detail_error = 'no Data in detail response'; return rec; }
        const a = o.Address || {};
        rec.legal_name = o.OutletName || '';
        rec.abn = o.BusinessNumber || '';
        rec.status = o.Status == null ? '' : String(o.Status);
        rec.categories = (o.Categories || []).map((c) => c.Name).filter(Boolean).join('; ');
        const street = [a.UnitNumber, a.StreetNumber, a.Address, a.StreetType].filter(Boolean).join(' ');
        rec.address = [street, a.Suburb, a.State, a.PostCode, a.Country].filter(Boolean).join(', ');
        rec.web = o.WebURL || o.Web || '';
      } catch (e) {
        rec.detail_error = isTimeout(e) ? 'timeout' : String((e && e.message) || e).slice(0, 200);
      }
      return rec;
    }));

    return {
      status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: `Search "${query}": ${matches.length} exact match(es) among ${outlets.length} outlet(s)`,
    };
  } catch (e) {
    return fail('couldnt_check', isTimeout(e) ? 'timeout' : 'other', searchUrl, (e && e.message) || e);
  }
}
