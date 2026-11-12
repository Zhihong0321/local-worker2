// The form check for one website: is there a contact form a bot can submit?
// Same reading as the hub's processLead form part (agy-lab/src/list-step2.ts): the homepage, the
// contact-ish links on it (up to three), then /contact-us and /contact when no page read so far
// is a contact page, and the verdict of the pages read, the first page with a form deciding.
import { getPage, ownSiteUrl } from './web.mjs';
import { formVerdict, researchLinks } from './forms.mjs';

const CONTACT_URL = /contact|hubungi|enquir|inquir|get-in-touch/i;
const VERIFY_TEXT = /verify (?:that )?you are human|checking your browser before accessing|unusual traffic from your computer|captcha challenge/i;

/**
 * Reads the homepage and its contact links. Returns the pages it could read (the caller's
 * fetchPage records them) and the errors of the rest. Never throws.
 */
async function readSite(home, fetchPage) {
  const errors = [];
  let homePage;
  try {
    homePage = await fetchPage(home);
  } catch (cause) {
    return { errors: [{ url: home, error: cause.message }] };
  }
  const queue = [homePage, ...researchLinks(homePage.html, homePage.url)];
  for (const item of queue) {
    let page;
    try {
      page = typeof item === 'string' ? await fetchPage(item) : item;
    } catch (cause) {
      errors.push({ url: String(item), error: cause.message });
      continue;
    }
    if (VERIFY_TEXT.test(String(page.html ?? '').replace(/<[^<>]*>/g, ' '))) {
      errors.push({ url: page.url, error: 'verification challenge' });
      break;
    }
  }
  return { errors };
}

/**
 * The form verdict for a lead's website.
 * status: bot_can_submit | captcha | script_form | no_form | unreachable | no_website | not_own_site
 * fetchPage is injectable so tests can run without the network.
 */
export async function scanWebsite(website, fetchPage = getPage) {
  const site = String(website ?? '').trim();
  const own = ownSiteUrl(site);
  if (!own) {
    return { status: !site ? 'no_website' : 'not_own_site', url: null, detail: '' };
  }
  const read = [];
  const get = async (url) => {
    const page = await fetchPage(url);
    read.push(page);
    return page;
  };
  let fresh = { errors: [] };
  try {
    fresh = await readSite(own, get);
  } catch (cause) {
    fresh = { errors: [{ error: cause.message }] };
  }
  if (!read.length) {
    return { status: 'unreachable', url: own, detail: String(fresh.errors?.[0]?.error ?? 'the homepage did not load') };
  }
  let verdict = formVerdict(read);
  // No contact page was linked: try the usual paths, the first that loads.
  if (verdict.status === 'no_form' && !read.some((p) => CONTACT_URL.test(p.url))) {
    for (const path of ['/contact-us', '/contact']) {
      try {
        await get(new URL(path, read[0].url).href);
        verdict = formVerdict(read);
        break;
      } catch { /* try the next */ }
    }
  }
  return { ...verdict, pages: read.map((p) => p.url) };
}
