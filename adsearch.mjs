// What an ads.research job searches for, worked out on the service so a change here
// reaches every PC on its next job without a new package (like strategy.mjs).
// A caller names a country and an industry; this turns them into the Meta Ad Library
// country code, Google's region id and the words to search in each place.

/** ISO 3166-1 alpha-2 -> [name, numeric]. Google's region id is 2000 plus the numeric code (Malaysia 2458). */
const COUNTRIES = {
  AE: ['United Arab Emirates', 784], AR: ['Argentina', 32], AT: ['Austria', 40], AU: ['Australia', 36], BD: ['Bangladesh', 50],
  BE: ['Belgium', 56], BG: ['Bulgaria', 100], BH: ['Bahrain', 48], BN: ['Brunei', 96], BR: ['Brazil', 76], CA: ['Canada', 124],
  CH: ['Switzerland', 756], CL: ['Chile', 152], CN: ['China', 156], CO: ['Colombia', 170], CY: ['Cyprus', 196], CZ: ['Czechia', 203],
  DE: ['Germany', 276], DK: ['Denmark', 208], DO: ['Dominican Republic', 214], DZ: ['Algeria', 12], EC: ['Ecuador', 218],
  EE: ['Estonia', 233], EG: ['Egypt', 818], ES: ['Spain', 724], ET: ['Ethiopia', 231], FI: ['Finland', 246], FR: ['France', 250],
  GB: ['United Kingdom', 826], GH: ['Ghana', 288], GR: ['Greece', 300], HK: ['Hong Kong', 344], HR: ['Croatia', 191], HU: ['Hungary', 348],
  ID: ['Indonesia', 360], IE: ['Ireland', 372], IL: ['Israel', 376], IN: ['India', 356], IQ: ['Iraq', 368], IS: ['Iceland', 352],
  IT: ['Italy', 380], JO: ['Jordan', 400], JP: ['Japan', 392], KE: ['Kenya', 404], KH: ['Cambodia', 116], KR: ['South Korea', 410],
  KW: ['Kuwait', 414], KZ: ['Kazakhstan', 398], LA: ['Laos', 418], LB: ['Lebanon', 422], LK: ['Sri Lanka', 144], LT: ['Lithuania', 440],
  LU: ['Luxembourg', 442], LV: ['Latvia', 428], MA: ['Morocco', 504], MM: ['Myanmar', 104], MO: ['Macau', 446], MT: ['Malta', 470],
  MV: ['Maldives', 462], MX: ['Mexico', 484], MY: ['Malaysia', 458], NG: ['Nigeria', 566], NL: ['Netherlands', 528], NO: ['Norway', 578],
  NP: ['Nepal', 524], NZ: ['New Zealand', 554], OM: ['Oman', 512], PA: ['Panama', 591], PE: ['Peru', 604], PH: ['Philippines', 608],
  PK: ['Pakistan', 586], PL: ['Poland', 616], PT: ['Portugal', 620], QA: ['Qatar', 634], RO: ['Romania', 642], RS: ['Serbia', 688],
  RU: ['Russia', 643], SA: ['Saudi Arabia', 682], SE: ['Sweden', 752], SG: ['Singapore', 702], SI: ['Slovenia', 705], SK: ['Slovakia', 703],
  TH: ['Thailand', 764], TN: ['Tunisia', 788], TR: ['Turkey', 792], TW: ['Taiwan', 158], TZ: ['Tanzania', 834], UA: ['Ukraine', 804],
  UG: ['Uganda', 800], US: ['United States', 840], UY: ['Uruguay', 858], UZ: ['Uzbekistan', 860], VN: ['Vietnam', 704], ZA: ['South Africa', 710],
};
const ALIASES = { UK: 'GB', USA: 'US', UAE: 'AE', 'VIET NAM': 'VN', 'SOUTH AFRICA': 'ZA', 'KOREA': 'KR', 'HONGKONG': 'HK' };

/** Company-name endings that turn a word into the way that country writes a business ("solar sdn bhd"). */
const LEGAL_FORMS = {
  MY: 'sdn bhd', SG: 'pte ltd', ID: 'pt', TH: 'co ltd', AU: 'pty ltd', GB: 'ltd', IN: 'pvt ltd', US: 'llc', PH: 'inc',
  VN: 'co ltd', HK: 'limited', NZ: 'limited', ZA: 'pty ltd', CA: 'inc', IE: 'ltd',
};

/** Words that find the same industry on Meta and Google. The first is the industry as asked. */
const INDUSTRIES = {
  solar: ['solar panel', 'solar installation', 'solar energy', 'photovoltaic'],
  '太阳能': ['太阳能板', '太阳能安装', '光伏', '太阳能发电'],
};
/** The industry in the country's own language, by country. */
const LOCAL_TERMS = {
  solar: { MY: ['panel solar', 'tenaga suria'], ID: ['panel surya', 'tenaga surya'], SG: [], TH: [] },
};

/** `{ code, name, googleRegion }`, or null when the text is neither an ISO code nor a known country name. */
export function country(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const code = ALIASES[upper] ?? (COUNTRIES[upper] ? upper : Object.keys(COUNTRIES).find((c) => COUNTRIES[c][0].toUpperCase() === upper));
  if (code) return { code, name: COUNTRIES[code][0], googleRegion: 2000 + COUNTRIES[code][1] };
  // A well-formed ISO code this table lacks still works on Meta; Google then needs googleRegion.
  return /^[A-Za-z]{2}$/.test(raw) ? { code: upper, name: upper, googleRegion: null } : null;
}

/**
 * `terms` are what Meta's Ad Library is searched for (a few); `googleQueries` are what Google's
 * advertiser search is asked, which also tries the country's company ending and name.
 */
export function searchTerms(industry, c, extra = []) {
  const key = industry.trim().toLowerCase();
  const own = INDUSTRIES[key] ?? [];
  const local = LOCAL_TERMS[key]?.[c.code] ?? [];
  const terms = [...new Set([key, ...extra.map((t) => t.trim().toLowerCase()).filter(Boolean), ...own, ...local])];
  const form = LEGAL_FORMS[c.code];
  const googleQueries = [...new Set(terms.flatMap((t, i) => [t, ...(i === 0 ? [form ? `${t} ${form}` : null, `${t} ${c.name.toLowerCase()}`] : [])]).filter(Boolean))].slice(0, 10);
  return { terms, googleQueries };
}
