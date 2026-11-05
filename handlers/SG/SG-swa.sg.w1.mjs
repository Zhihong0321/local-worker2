export const meta = {
  task: 'SG-swa.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'agency or project name',
  fields: ['project', 'year', 'agency', 'awards', 'category', 'score'],
  canary: { found: 'Elves Lab', not_found: 'Verz Design' }
};

export default async function lookup(keyword) {
  const source_url = 'https://www.swa.sg/winners/';
  try {
    const res = await fetch(source_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url,
        excerpt: `HTTP status ${res.status}`
      };
    }

    const html = await res.text();

    if (!html.includes('e-loop-item') || !html.includes('Winners')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: 'Expected loop-item elements or Winners title not found in HTML'
      };
    }

    const items = [...html.matchAll(/<div data-elementor-type="loop-item"[\s\S]*?(?=<div data-elementor-type="loop-item"|$)/gi)].map(m => m[0]);
    const winners = [];

    for (const item of items) {
      const nomMatch = item.match(/href="(https:\/\/www\.swa\.sg\/nominees\/(\d{4})\/([^"/]+)\/)"/i);
      const titleMatch = item.match(/<h4[^>]*><a[^>]*>([\s\S]*?)<\/a><\/h4>/i);
      const agencyMatch = item.match(/<p class="elementor-heading-title[^"]*"><a[^>]*>([\s\S]*?)<\/a><\/p>/i);
      const awardsMatch = [...item.matchAll(/href="https:\/\/www\.swa\.sg\/winners\/([^"/]+)\/"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => m[2].trim());
      const catMatch = item.match(/href="https:\/\/www\.swa\.sg\/(commercial|ecommerce|personal)\/"[^>]*>([\s\S]*?)<\/a>/i);
      const scoreMatch = item.match(/<h2 class="elementor-heading-title[^"]*">(\d+%)<\/h2>/i);

      if (nomMatch || titleMatch) {
        winners.push({
          project: titleMatch ? titleMatch[1].replace(/&#8217;/g, "'").trim() : '',
          year: nomMatch ? nomMatch[2] : '',
          url: nomMatch ? nomMatch[1] : '',
          agency: agencyMatch ? agencyMatch[1].trim() : '',
          awards: awardsMatch.join(', '),
          category: catMatch ? catMatch[2].trim() : '',
          score: scoreMatch ? scoreMatch[1] : '',
          raw: item.slice(0, 500)
        });
      }
    }

    if (winners.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: 'Zero winner items parsed from loop-item blocks'
      };
    }

    const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = clean(keyword);
    const targetWords = target.split(' ').filter(w => !['pte', 'ltd', 'inc', 'co', 'the'].includes(w) && w.length > 2);

    const matched = winners.filter(w => {
      const cAgency = clean(w.agency);
      const cProject = clean(w.project);
      if (cAgency.includes(target) || cProject.includes(target)) return true;
      if (targetWords.length > 0 && targetWords.every(word => cAgency.includes(word) || cProject.includes(word))) {
        return true;
      }
      return false;
    });

    if (matched.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matched.map(m => ({
          project: m.project,
          year: m.year,
          agency: m.agency,
          awards: m.awards,
          category: m.category,
          score: m.score
        })),
        source_url,
        excerpt: matched[0].raw
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: ''
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: err.message
    };
  }
}
