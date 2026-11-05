export const meta = {
  task: 'AU-webawards.com.au',
  want: 'w1',
  tier: 2,
  method: 'get',
  input: 'company name',
  fields: ['agency', 'project', 'category', 'year', 'award_type'],
  canary: {
    found: 'Chromatix',
    not_found: 'Defyn Digital'
  }
};

const ARCHIVE_YEARS = [
  '2026', '2025', '2024', '2023', '2022',
  '2021', '2020', '2019', '2017', '2016', '2015'
];

function norm(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/&/g, 'and')
    .replace(/\b(pty|ltd|limited|proprietary|digital|agency)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCompany(agencyText, keyword) {
  if (!agencyText || !keyword) return false;
  const aNorm = norm(agencyText);
  const kNorm = norm(keyword);
  if (aNorm === kNorm || aNorm.includes(kNorm)) return true;

  const stopWords = new Set(['the', 'and', 'by']);
  const keyWords = kNorm.split(' ').filter(w => !stopWords.has(w) && w.length > 1);
  if (keyWords.length === 0) return aNorm.includes(kNorm);

  const aWords = new Set(aNorm.split(' '));
  return keyWords.every(w => aWords.has(w));
}

function parseYearPage(html, year, cleanKeyword) {
  const records = [];
  const catSections = html.split(/<div[^>]+class=["'][^"']*award-category[^"']*["']/gi);

  for (let i = 1; i < catSections.length; i++) {
    const sec = catSections[i];
    const catMatch = sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const category = catMatch ? catMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const titleBars = [...sec.matchAll(/class=["'](winner|finalist)["'][\s\S]*?<div class="title">([\s\S]*?)<\/div>[\s\S]*?<div class="agency">([\s\S]*?)<\/div>/gi)];
    for (const tb of titleBars) {
      const type = tb[1].toLowerCase() === 'winner' ? 'Winner' : 'Finalist';
      const project = tb[2].replace(/<[^>]+>/g, '').trim();
      const rawAgency = tb[3].replace(/<[^>]+>/g, '').trim();
      const agency = rawAgency.replace(/^By\s+/i, '').trim();

      if (matchCompany(agency, cleanKeyword) || matchCompany(project, cleanKeyword)) {
        records.push({
          agency,
          project,
          category,
          year,
          award_type: type
        });
      }
    }
  }

  return records;
}

/** Look one company up across AWA winners archives. Must never throw. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = (keyword || '').trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://webawards.com.au/winners/',
        excerpt: 'Empty search keyword'
      };
    }

    const allRecords = [];
    let sourceUrl = 'https://webawards.com.au/winners/';

    for (const year of ARCHIVE_YEARS) {
      const url = `https://webawards.com.au/winners/${year}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!res.ok) continue;

      const html = await res.text();
      // Check layout sanity
      if (!html.includes('award-category')) {
        continue;
      }

      const yearRecords = parseYearPage(html, year, cleanKeyword);
      if (yearRecords.length > 0) {
        allRecords.push(...yearRecords);
        sourceUrl = url;
        // Break early once verified in the official winners index
        break;
      }
    }

    if (allRecords.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://webawards.com.au/winners/',
        excerpt: `No Australian Web Awards (AWA) wins or finalist accolades found in official index for "${cleanKeyword}"`
      };
    }

    const excerpt = `Found ${allRecords.length} AWA award entry/entries: ${allRecords.map(r => `${r.project} (${r.year} ${r.award_type} - ${r.category}, by ${r.agency})`).join('; ')}`.slice(0, 500);

    return {
      status: 'found',
      reason: '',
      records: allRecords,
      source_url: sourceUrl,
      excerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://webawards.com.au/winners/',
      excerpt: `Lookup exception: ${err.message}`
    };
  }
}
