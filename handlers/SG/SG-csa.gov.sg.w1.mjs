export const meta = {
  task: 'SG-csa.gov.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'mark', 'validity'],
  pdf: true,
  canary: {
    found: 'ACCEDE CORPORATE SERVICES PTE LTD',
    not_found: 'Verz Design',
  },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  return {
    status: 'couldnt_check',
    reason: 'pdf',
    records: [],
    source_url: 'https://file.go.gov.sg/cem-certified-organisations.pdf',
    excerpt: '',
  };
}
