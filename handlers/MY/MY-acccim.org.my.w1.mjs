export const meta = {
  task: 'MY-acccim.org.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['name', 'website', 'principal_business', 'intended_cooperation', 'contact'],
  canary: { found: 'Koon Brother Sdn Bhd', not_found: '马来西亚虚构企业有限公司' },
};

// ACCCIM Business Directory, August 2026 edition (the newest one on the e-books pages of acccim.org.my).
// The site's own search does not cover this PDF, so the hub reads the PDF itself.
const PDF_URL = 'https://acccim.org.my/wp-content/uploads/2026/08/202608-%E4%B8%AD%E6%80%BB%E4%BC%81%E4%B8%9A%E5%90%8D%E5%BD%95ACCCIM-Business-Directory.pdf';
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
    const head = Array.from(bytes.slice(0, 60), (b) => String.fromCharCode(b)).join('');
    if (!head.startsWith('%PDF-')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL,
               excerpt: `expected a PDF, got: ${head}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `Directory PDF (${bytes.length} bytes) is up; the hub reads the PDF to match "${keyword}"`,
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
