export const meta = { task: 'JP-keidanren.or.jp', want: 'w1', tier: 1, method: 'get', pdf: true, input: 'company name',
  fields: ['name', 'membership_category', 'list_source'],
  canary: { found: 'トヨタ自動車（株）', not_found: '架空商事株式会社' } };

// Keidanren publishes its corporate member roster only as a PDF (企業会員一覧, 1,600+ names, as of 2026-11-09).
// The handler does not search the PDF; it checks the PDF is really there and hands it to the hub.
const PDF_URL = 'https://www.keidanren.or.jp/profile/kaiin/kigyo.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      // 'Connection: close' stops a Node-on-Windows libuv assertion at process exit (seen 8/10 runs without it).
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8', 'Connection': 'close' },
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
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF, starts with: ${head}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: 'Keidanren corporate member list (企業会員一覧), PDF. The hub reads the PDF to match the company name.',
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PDF_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
