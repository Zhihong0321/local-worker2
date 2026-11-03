// What a worker sweeps. Read by the worker on every job (GET /api/worker/strategy),
// so changing a word here changes every PC's next scan without a new package.

/** Results kept when a job names no `max`. */
export const DEFAULT_MAX = 200;
export const MAX_LIMIT = 500;
/** A Business scan also searches "<form> in <street>" for each street found. */
export const STREET_FORMS = ['shop', 'company'];
/** Below this share of rows naming the place, the place is not how Google writes addresses there: keep everything. */
export const AREA_MATCH_FLOOR = 0.3;

/**
 * Keyword families, each ordered by how many new in-area places a word added in
 * the 2026-10-24 sweeps of Kawasan Perindustrian Tebrau (industrial) and Taman
 * Daya (mixed). Near-synonyms that added almost nothing are left out.
 */
const FACTORY = [
  'factory', 'sdn bhd', 'food', 'company', 'manufacturer', 'manufacturing', 'construction',
  'engineering', 'warehouse', 'trading', 'furniture', 'wholesale', 'logistics', 'plastic',
  'machinery', 'steel', 'printing', 'packaging', 'supplier',
];
const SHOP = [
  'shop', 'restaurant', 'salon', 'car', 'store', 'laundry', 'clinic', 'bakery', 'kedai',
  'electronics', 'hardware', 'cafe', 'retail', 'mart', 'tyre', 'spa',
];
/** Every kind of business: the categories that each added most in Taman Daya, then both families. */
const BUSINESS = [...new Set([
  'restaurant', 'salon', 'factory', 'company', 'business', 'sdn bhd', 'construction', 'tuition',
  'car', 'shop', 'property', 'trading', 'services', 'wholesale', 'manufacturer', 'office',
  'workshop', 'agency', 'laundry', 'hotel', 'contractor', 'kindergarten', ...FACTORY, ...SHOP,
])];
export const FAMILIES = { business: BUSINESS, factory: FACTORY, shop: SHOP };

export function strategy() {
  return { families: FAMILIES, streetForms: STREET_FORMS, areaMatchFloor: AREA_MATCH_FLOOR, defaultMax: DEFAULT_MAX };
}
