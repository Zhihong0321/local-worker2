export const meta = {
  task: 'PH-cda.gov.ph',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['registration_no', 'name', 'region', 'province', 'municipality', 'street', 'category', 'cooperative_type', 'status'],
  canary: { found: 'Cooperative Bank of Benguet (CBB)', not_found: 'Samahang Hindi Umiiral Kailanman' },
};

// CDA "Cooperative Masterlist" page (https://cda.gov.ph/cooperative-masterlist/) links to this PDF:
// "LIST OF COOPERATIVES, December 31, 2024" (the newest list on the page).
const PDF_URL = 'https://cda.gov.ph/wp-content/uploads/2025/08/For-posting_2024-data.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await checkPdf(keyword);
  // On this PC (Node 24 / Windows) the runner calls process.exit right after the answer, and that crashes
  // while the fetch socket is still closing. A short pause lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}

async function checkPdf(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      headers: { 'user-agent': UA, 'accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }

    // Read only the first bytes (the file is ~18 MB); the hub reads the PDF itself.
    let head = new Uint8Array(0);
    if (res.body) {
      const reader = res.body.getReader();
      while (head.length < 8) {
        const { done, value } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(head.length + value.length);
        merged.set(head, 0);
        merged.set(value, head.length);
        head = merged;
      }
      await reader.cancel().catch(() => {});
    }

    const magic = new TextDecoder().decode(head.slice(0, 5));
    if (magic !== '%PDF-') {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: PDF_URL,
        excerpt: `expected a PDF, got starts with: ${new TextDecoder().decode(head.slice(0, 40))}`,
      };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of registered cooperatives (as of December 31, 2024), keyword not checked: ${keyword}`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PDF_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
