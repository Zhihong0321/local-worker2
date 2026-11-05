export const meta = {
  task: 'MY-customs.gov.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['name', 'agent_code', 'agent_type', 'station'],
  canary: { found: 'Multi-Trans Sdn Bhd', not_found: 'O2O Digital' },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pdfUrl = 'https://www.customs.gov.my/images/04-fasilitasi/ejen-kastam/3-3-Senarai-maklumat-ejen-kastam-yang-telah-dikemaskini-sehingga-Mei-2026.pdf';
  try {
    const res = await fetch(pdfUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pdfUrl,
        excerpt: `HTTP status ${res.status}`
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: pdfUrl,
      excerpt: 'Registered Customs Agent list (Senarai maklumat ejen kastam) under Section 90 of Customs Act 1967 is published as a PDF directory.'
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: pdfUrl,
      excerpt: String(err)
    };
  }
}
