export const meta = {
  task: 'SG-customs.gov.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'tier', 'validity'],
  pdf: true,
  canary: {
    found: 'Apex Logistics Pte Ltd',
    not_found: 'Makoto-Ya Singapore',
  },
};

/** Look one company up in published STP / STP-Plus PDF list. */
export default async function lookup(keyword) {
  return {
    status: 'couldnt_check',
    reason: 'pdf',
    records: [],
    source_url: 'https://isomer-user-content.by.gov.sg/174/137c4086-01d5-4992-9511-bb1110b1a909/STP Certified Companies 21 July 2026.pdf',
    excerpt: '',
  };
}
