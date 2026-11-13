export const meta = {
  task: 'JP-mhlw.go.jp',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['name', 'address', 'announced_date', 'violated_articles', 'summary', 'other_notes'],
  canary: { found: '田中石灰工業（株）', not_found: '存在しない株式会社ゼロ' },
};

// Current roster PDF (労働基準関係法令違反に係る公表事案, 令和7年7月1日～令和8年6月30日公表分).
// MHLW publishes a new PDF each period; update this address when a newer one is published.
const PDF_URL = 'https://www.mhlw.go.jp/content/001725374.pdf';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = String.fromCharCode(...bytes.slice(0, 5));
    if (head !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF: ${head}` };
    }

    // The roster is a PDF list. The hub reads the PDF itself and matches the company there.
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF roster fetched (${bytes.length} bytes) for "${keyword}"`,
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
