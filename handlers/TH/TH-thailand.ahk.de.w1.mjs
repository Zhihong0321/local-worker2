export const meta = { task: 'TH-thailand.ahk.de', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name'], canary: { found: 'Bangkok Bank Public Co., Ltd.', not_found: 'บริษัท ทดสอบ ไม่มีจริง จำกัด' } };

// The GTCC member directory is not online yet. The site links the current member list as one PDF
// ("Member List_15 10 2026", updated 15 October 2026). The hub reads that PDF itself, so this handler only
// fetches it, checks it is really a PDF, and hands the address over with reason 'pdf'.
const PDF_URL = 'https://thailand.ahk.de/de/content/pdf-download/996684/19984176?inLanguage=eng-GB';
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
    const magic = String.fromCharCode(...bytes.subarray(0, 5));
    if (magic !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL,
               excerpt: `expected a PDF, got: ${magic.replace(/[^\x20-\x7e]/g, '.')}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `GTCC member list PDF (Updated 15 October 2026), ${bytes.length} bytes; lookup of "${String(keyword || '').slice(0, 120)}" is done on the PDF`,
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
