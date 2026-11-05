// Offline fixture only; no claim about this company's presence on the live site.
export const meta = { task: 'SG-sgx.com', want: 'w1', tier: 1, method: 'fetch', canary: { found: 'DBS', not_found: 'Microsoft' } };
export default async function lookup(keyword) {
  return { status: keyword === meta.canary.found ? 'found' : 'not_found', reason: null, records: keyword === meta.canary.found ? [{ name: keyword }] : [] };
}
