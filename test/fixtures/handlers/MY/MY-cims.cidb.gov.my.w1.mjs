// Offline fixture only; no claim about this company's presence on the live site.
export const meta = { task: 'MY-cims.cidb.gov.my', want: 'w1', tier: 2, method: 'form_post', canary: { found: 'Gamuda', not_found: 'Microsoft' } };
export default async function lookup(keyword) {
  return { status: keyword === meta.canary.found ? 'found' : 'not_found', reason: null, records: keyword === meta.canary.found ? [{ name: keyword }] : [] };
}
