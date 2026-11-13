export const meta = { task: 'SG-jcci.org.sg', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name', 'address', 'joined_year_month'],
  canary: { found: 'KOKUYO Workplace Singapore Pte. Ltd.', not_found: '新加坡虚构贸易有限公司' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOME = 'https://www.jcci.org.sg/';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 *  The public member-roster (会員名簿) is behind the member login, so the only public company list is the
 *  monthly new-member PDF linked from the home page. This handler finds that PDF and hands it to the hub. */
export default async function lookup(keyword) {
  try {
    // Step 1: find the newest new-member PDF on the home page.
    const homeRes = await fetch(HOME, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000)
    });
    if (homeRes.status === 403 || homeRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: HOME, excerpt: `HTTP ${homeRes.status}` };
    }
    if (!homeRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: HOME, excerpt: `HTTP ${homeRes.status}` };
    }
    const homeHtml = await homeRes.text();
    const linkMatch = homeHtml.match(/href="([^"]*入会企業\.pdf)"/);
    if (!linkMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: HOME,
               excerpt: 'no new-member PDF link (入会企業.pdf) on the home page' };
    }
    const pdfUrl = new URL(linkMatch[1], HOME).href;

    // Step 2: check the file really is a PDF, then leave the reading to the hub.
    const pdfRes = await fetch(pdfUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000)
    });
    if (pdfRes.status === 403 || pdfRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pdfUrl, excerpt: `HTTP ${pdfRes.status}` };
    }
    if (!pdfRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pdfUrl, excerpt: `HTTP ${pdfRes.status}` };
    }
    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    const magic = String.fromCharCode(...bytes.slice(0, 5));
    if (magic !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pdfUrl,
               excerpt: `expected a PDF, got: ${magic}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: pdfUrl,
      excerpt: `new-member PDF (入会企業) for lookup "${keyword}"; the hub reads the PDF`
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: HOME,
      excerpt: String(err?.message || err).slice(0, 300)
    };
  }
}
