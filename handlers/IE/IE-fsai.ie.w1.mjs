export const meta = { task: 'IE-fsai.ie', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['premises', 'address', 'county', 'served_on', 'business_type', 'issuing_agency', 'legislation', 'date_served', 'date_lifted'],
  canary: { found: "Carolyn's Sweets", not_found: 'Grupa Bia Gaelach Teoranta' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ENFORCEMENT_PAGE = 'https://www.fsai.ie/enforcement-and-legislation/enforcement';

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** The FSAI publishes its enforcement orders as PDF lists, not as searchable records. This handler finds the current
 *  Closure Orders PDF on the enforcement page and hands it to the hub, which reads the PDF itself. */
export default async function lookup(keyword) {
  try {
    const pageRes = await fetch(ENFORCEMENT_PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', ENFORCEMENT_PAGE, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return fail('http_error', ENFORCEMENT_PAGE, `HTTP ${pageRes.status}`);

    const html = await pageRes.text();
    if (!html.includes('Closure Orders') || !html.includes('Enforcement Orders')) {
      return fail('layout_changed', ENFORCEMENT_PAGE, html.slice(0, 300));
    }

    const hrefMatch = html.match(/href="(\/getmedia\/[^"]*Closure-Orders[^"]*\.pdf)"/i);
    if (!hrefMatch) return fail('layout_changed', ENFORCEMENT_PAGE, 'no Closure Orders PDF link on the page');
    const pdfUrl = new URL(hrefMatch[1].replace(/&amp;/g, '&'), 'https://www.fsai.ie').href;

    const pdfRes = await fetch(pdfUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (pdfRes.status === 403 || pdfRes.status === 429) return fail('blocked', pdfUrl, `HTTP ${pdfRes.status}`);
    if (!pdfRes.ok) return fail('http_error', pdfUrl, `HTTP ${pdfRes.status}`);

    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    const head = String.fromCharCode(...bytes.slice(0, 5));
    if (head !== '%PDF-') return fail('layout_changed', pdfUrl, `not a PDF, starts with: ${head}`);

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: pdfUrl,
      excerpt: `Closure Orders PDF (${bytes.length} bytes) for "${keyword}"; the hub reads the list.`,
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, ENFORCEMENT_PAGE, String(err?.message || err));
  }
}
