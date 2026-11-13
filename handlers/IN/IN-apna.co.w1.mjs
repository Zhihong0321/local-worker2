export const meta = {
  task: 'IN-apna.co',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'vacancies', 'url'],
  canary: { found: 'Hdfc Life Insurance Company Limited', not_found: 'Zorvex Nonexistent Trading Private Limited' },
};

// Apna has one public page per employer that posts jobs: https://apna.co/jobs/<name_slug>-jobs
// The slug is the company name in lower case with every run of non-letters/digits turned into "_".
// A 404 on that page is the site's own "no such page" answer, so it is treated as not_found.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://apna.co';
const LEGAL_PAIR = { private: 'pvt', pvt: 'private', limited: 'ltd', ltd: 'limited' };
const LEGAL_CANON = { pvt: 'private', ltd: 'limited' };

function latinTokens(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/** Name key used for matching: case, punctuation and "Pvt"/"Private", "Ltd"/"Limited" do not matter. */
function nameKey(tokens) {
  return tokens.map((t) => LEGAL_CANON[t] || t).join('');
}

/** Slug variants: the name as typed first, then with Pvt/Private and Ltd/Limited written the other way. */
function slugCandidates(tokens) {
  let variants = [[]];
  for (const t of tokens) {
    const alts = LEGAL_PAIR[t] ? [t, LEGAL_PAIR[t]] : [t];
    const next = [];
    for (const v of variants) for (const a of alts) next.push([...v, a]);
    variants = next;
  }
  const seen = new Set();
  const out = [];
  for (const v of variants) {
    const s = v.join('_');
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.slice(0, 4);
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** Reads the company name, vacancy count and company id from a company jobs page. Returns null if the layout is not as expected. */
function parseCompanyPage(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1) return null;
  const h1Text = decodeEntities(h1[1].replace(/<[^>]+>/g, ' '));
  const m = h1Text.match(/^(.*?)\s+Jobs\b(?:\s*-\s*(\d[\d,]*)\+?\s+Verified\s+Vacanc\w*)?/i);
  if (!m || !m[1].trim()) return null;
  const idMatch = html.match(/organisationID\\?"\s*:\s*(\d+)/) || html.match(/companyId\\?"\s*:\s*(\d+)/);
  return {
    name: m[1].trim(),
    vacancies: m[2] ? Number(m[2].replace(/,/g, '')) : null,
    company_id: idMatch ? idMatch[1] : '',
    title: h1Text,
  };
}

function answer(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    const letters = input.match(/\p{L}/gu) || [];
    const latin = input.match(/\p{Script=Latin}/gu) || [];
    const tokens = latinTokens(input);
    if (!tokens.length || latin.length < letters.length) {
      return answer('couldnt_check', 'other', `${BASE}/jobs/`,
        'the name has no Latin-script letters that an Apna company page slug could be built from');
    }

    const key = nameKey(tokens);
    const cands = slugCandidates(tokens);
    const start = Date.now();
    const firstUrl = `${BASE}/jobs/${cands[0]}-jobs`;
    const tried = [];

    for (let i = 0; i < cands.length; i++) {
      if (i > 0 && Date.now() - start > 30000) {
        return answer('couldnt_check', 'timeout', firstUrl,
          `stopped after ${i} of ${cands.length} address variants to stay under 60 s`);
      }
      const url = `${BASE}/jobs/${cands[i]}-jobs`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return answer('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      }
      if (res.status === 404) {
        tried.push(url);
        continue;
      }
      if (!res.ok) {
        return answer('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
      }

      const html = await res.text();
      const page = parseCompanyPage(html);
      if (!page) {
        const botCheck = /captcha|Just a moment|cf-chl|Verify you are human/i.test(html.slice(0, 20000));
        return answer('couldnt_check', botCheck ? 'blocked' : 'layout_changed', url,
          botCheck ? 'bot check page' : 'company page did not show the expected title line');
      }

      if (nameKey(latinTokens(page.name)) !== key) {
        // A page exists, but it is for a different name; keep looking at the other variants.
        tried.push(url);
        continue;
      }

      const vac = page.vacancies === null ? 'vacancy count not shown' : `${page.vacancies} verified vacancies`;
      return answer('found', '', url, `${page.name}: ${vac} on apna.co`, [{
        name: page.name,
        company_id: page.company_id,
        vacancies: page.vacancies,
        url,
      }]);
    }

    return answer('not_found', '', firstUrl,
      `no Apna company jobs page for "${input}" (tried: ${tried.join(', ')})`);
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return answer('couldnt_check', reason, `${BASE}/jobs/`, String(err && err.message ? err.message : err).slice(0, 300));
  }
}
