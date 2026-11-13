export const meta = { task: 'SG-rom.mlaw.gov.sg', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['business_name', 'business_address', 'licence_no', 'landline', 'business_urls'],
  canary: { found: '1ST CAPITAL PTE. LTD.', not_found: '新加坡放贷有限公司' } };

// The official "List of Valid Moneylenders" PDF linked from https://rom.mlaw.gov.sg/information-for-borrowers/list-of-licensed-moneylenders-in-singapore/
const PDF_URL = 'https://file.go.gov.sg/mlaw-rom-list-licensed-moneylenders.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PDF_URL, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    // Only the PDF address is checked here; the hub reads the list itself (pdf: true).
    const res = await fetch(PDF_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = String.fromCharCode(...bytes.slice(0, 5));
    if (head !== '%PDF-') return couldnt('layout_changed', `expected a PDF, got starting bytes "${head}"`);

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of valid moneylenders (${bytes.length} bytes); not searched here for "${keyword}"`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timedOut ? 'timeout' : 'other', String(err?.message || err).slice(0, 200));
  }
}
