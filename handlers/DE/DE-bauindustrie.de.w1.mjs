export const meta = {
  task: 'DE-bauindustrie.de',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['rank', 'name', 'city', 'total_revenue_eur_m', 'foreign_share_pct', 'profit_before_tax_eur_m', 'employees'],
  canary: { found: 'Hochtief', not_found: 'Nichtexistierende Bau GmbH' },
};

// The site publishes one PDF: the 50 largest German construction companies (ranking, 2025 edition).
// It is not a company register; the site itself says it cannot list all member companies.
const PDF_URL = 'https://www.bauindustrie.de/fileadmin/bauindustrie.de/Zahlen_Fakten/Uebersicht-Bauunternehmen/Liste_der_50_gr%C3%B6%C3%9Ften_deutschen_Bauunternehmen_in_2025.pdf';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,*/*;q=0.8',
      },
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }

    const head = new Uint8Array(await res.arrayBuffer()).slice(0, 5);
    const magic = String.fromCharCode(...head);
    if (magic !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF, starts with: ${magic}` };
    }

    // The hub reads the PDF itself and matches the company name against it.
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of the 50 largest German construction companies (2025), looking up: ${keyword}`,
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
