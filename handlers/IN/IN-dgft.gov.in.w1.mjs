export const meta = {
  task: 'IN-dgft.gov.in',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['name', 'penalty_date', 'penalty_amount', 'iec_cancelled', 'placed_in_del'],
  canary: { found: 'KARAN OVERSEAS', not_found: 'शून्य व्यापार प्राइवेट लिमिटेड' },
};

// DGFT has no name search on its public pages. The "View any IEC" lookup needs an IEC number and a captcha, so it is not used.
// The public company list is a static PDF: "Action taken for misuse of facilities under Export Promotion Schemes"
// (content.dgft.gov.in, linked from dgft.gov.in > Action taken on the defaulters). Each row is a firm, its penalty date,
// amount, whether its IEC was cancelled and whether it was placed on the Denied Entity List (DEL).
// The second PDF ("Details of the companies which have misused facilities of Export Promotion Schemes", 13.07.2020,
// https://content.dgft.gov.in/Website/Penalty2019.pdf) is NOT covered by this handler (one address per handler).
const PDF_URL = 'https://content.dgft.gov.in/Website/dgftprod/3e56184b-c03a-405b-97e1-c84b7db33d9e/Action%20Against%20EO%20Scheme.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 5));
    if (head !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF: ${head}` };
    }

    // The hub reads the PDF itself and matches the company name against its rows.
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list (${bytes.length} bytes) for "${String(keyword).slice(0, 120)}"; the hub reads it`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: PDF_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
