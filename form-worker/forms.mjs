// Contact-form reading from page HTML: the same rules the hub uses (agy-lab/src/list-step2.ts
// formVerdict, formsInHtml, pageCaptcha; agy-lab/src/contact-form-delivery.ts classify, pickForm,
// readOutcome; agy-lab/src/site-emails.ts contactLinks). Pure functions, no network, no browser.
//
// Port notes: a character code outside Unicode is shown as U+FFFD instead of throwing, so one
// freak page never stops a run. Everything else is the hub's logic, line for line where it matters.

const MAX_FORM_HTML = 1_500_000;

const safeCodePoint = (n) => {
  try { return String.fromCodePoint(n); } catch { return '�'; }
};

export const decode = (s) => String(s ?? '')
  .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');

export const textOf = (html) => decode(String(html ?? '').replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function attrs(inside) {
  const out = {};
  for (const m of String(inside ?? '').matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'file']);
// Every repeat here is bounded: an unbounded one runs in quadratic time on a freak page.
const FORM_CAPTCHA = /\b(g-recaptcha|h-captcha|cf-turnstile)\b|data-sitekey|<iframe[^>]{0,500}src\s*=\s*["'][^"']{0,300}(captcha|turnstile)|<img[^>]{0,500}src\s*=\s*["'][^"']{0,300}captcha|<input[^>]{0,500}name\s*=\s*["'][^"']{0,100}captcha/i;
const FORM_QUIZ = /(?<!\d)\d{1,3}\s{0,3}[+x×*-]\s{0,3}\d{1,3}\s{0,3}=|captcha|are you human|bukan robot/i;
const CONTACT_URL = /contact|hubungi|enquir|inquir|get-in-touch/i;
// Site builders and form services that draw the form with script, so the HTML has none to read.
const SCRIPT_FORM = /static\.parastorage\.com|wix\.com\/|hbspt\.forms|js\.hsforms\.net|jotform\.com|typeform\.com|forms\.gle|docs\.google\.com\/forms|formstack\.com|cognitoforms\.com|tally\.so|squarespace\.com|weebly\.com|webflow\.com/i;

/** The page without comments, scripts and styles, in one pass; an unclosed one hides the rest of the page. */
export function stripBlocks(html) {
  const open = /<!--|<(script|style)\b/gi;
  let out = '';
  let pos = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    out += html.slice(pos, m.index);
    const close = m[1] ? new RegExp(`</${m[1]}\\s*>`, 'gi') : /-->/g;
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) return out;
    pos = open.lastIndex = c.index + c[0].length;
  }
  return out + html.slice(pos);
}

/** Each <tag ...>inner</tag> in order, in one pass; an unclosed one ends the search. */
export function* elements(html, tag) {
  const open = new RegExp(`<${tag}\\b([^>]{0,2000})>`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'gi');
  for (let m = open.exec(html); m; m = open.exec(html)) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) return;
    yield { attrs: m[1], inner: html.slice(open.lastIndex, c.index) };
    open.lastIndex = c.index + c[0].length;
  }
}

/** The forms in a page's HTML, as a browser would read them. Forms drawn by script are not here. */
export function formsInHtml(html) {
  const clean = stripBlocks(String(html ?? '').slice(0, MAX_FORM_HTML));
  const forms = [];
  let n = 0;
  for (const form of elements(clean, 'form')) {
    const body = form.inner;
    const id = `f${n++}`;
    const labels = new Map();
    for (const l of elements(body, 'label')) {
      const a = attrs(l.attrs);
      if (a.for) labels.set(a.for, textOf(l.inner));
    }
    const fields = [];
    let submitText = '';
    for (const f of body.matchAll(/<(input|textarea|select)\b([^>]{0,2000})>/gi)) {
      const tag = f[1].toLowerCase();
      const a = attrs(f[2]);
      const type = (a.type || (tag === 'input' ? 'text' : '')).toLowerCase();
      if (type === 'submit' && !submitText) submitText = a.value || 'submit';
      if (SKIP_TYPES.has(type) || 'disabled' in a || 'readonly' in a) continue;
      let label = [labels.get(a.id ?? ''), a['aria-label'], a.placeholder, a.title].filter(Boolean).join(' ');
      // <label>Email <input></label>, or a caption just before the box.
      if (!label.trim()) label = textOf(body.slice(Math.max(0, f.index - 300), f.index)).slice(-80);
      label = label.replace(/\s+/g, ' ').trim().slice(0, 160);
      fields.push({
        id: `${id}-${fields.length}`, tag, type, name: a.name || a.id || '', label,
        required: 'required' in a || a['aria-required'] === 'true' || /\*/.test(label),
      });
    }
    submitText ||= textOf(/<button\b[^>]{0,1000}>([\s\S]{0,2000}?)<\/button>/i.exec(body)?.[1] ?? '');
    forms.push({
      id, fields, submitText,
      captcha: FORM_CAPTCHA.test(body) ? 'a captcha on the form' : FORM_QUIZ.test(textOf(body)) ? 'a question that checks for robots' : null,
    });
  }
  return forms;
}

/** A captcha anywhere on the page. */
export function pageCaptcha(full) {
  const html = String(full ?? '').slice(0, MAX_FORM_HTML);
  const title = /<title[^>]{0,500}>([\s\S]{0,2000}?)<\/title>/i.exec(html)?.[1] ?? '';
  if (/just a moment|attention required|verify you are human/i.test(title)) return 'a Cloudflare check guards the page';
  if (/google\.com\/recaptcha|recaptcha\/api\.js|grecaptcha|g-recaptcha/i.test(html)) return 'reCAPTCHA';
  if (/hcaptcha\.com|h-captcha/i.test(html)) return 'hCaptcha';
  if (/challenges\.cloudflare\.com|cf-turnstile/i.test(html)) return 'Cloudflare Turnstile';
  if (/friendlycaptcha|frc-captcha|mtcaptcha|captcha\.(png|jpg|php)|really-simple-captcha|wpcf7-quiz|si_captcha/i.test(html)) return 'a captcha';
  return null;
}

/** What a box is for, from its type, name, label and placeholder (English and Malay). */
export function classify(f) {
  const t = String(f.type || '').toLowerCase();
  const s = `${f.name} ${f.label}`.toLowerCase().replace(/[_\-[\]]+/g, ' ');
  if (f.tag === 'textarea') return 'message';
  if (t === 'checkbox') return /agree|consent|privacy|terms|accept|setuju|pdpa|gdpr/.test(s) ? 'consent' : null;
  if (t === 'email' || /e-?mail|emel/.test(s)) return 'email';
  if (t === 'tel' || /phone|mobile|tel\b|telefon|whatsapp|contact no|hp\b|handphone/.test(s)) return 'phone';
  if (t === 'url' || /website|web site|url|laman web/.test(s)) return 'website';
  if (/company|organi[sz]ation|business|syarikat|firm\b/.test(s)) return 'company';
  if (/subject|topic|tajuk|perkara|regarding/.test(s)) return 'subject';
  if (/first ?name|given name|fname|nama pertama/.test(s)) return 'first_name';
  if (/last ?name|surname|family name|lname/.test(s)) return 'last_name';
  if (/name|nama/.test(s)) return 'name';
  if (/message|comment|enquiry|inquiry|mesej|pertanyaan|details|how can we help/.test(s)) return 'message';
  return null;
}

/** The contact form among a page's forms: a message box plus a way to answer. Newsletter, search and login forms never qualify. */
export function pickForm(forms) {
  let best = null;
  let bestScore = 0;
  for (const form of forms) {
    // A mailto: form opens the visitor's mail app on this PC, so it is never picked.
    if (form.mailto) continue;
    const kinds = form.fields.map(classify);
    if (form.fields.some((f) => f.type === 'password' || f.type === 'search')) continue;
    if (!kinds.includes('message') || !(kinds.includes('email') || kinds.includes('phone'))) continue;
    const score = 4 + (kinds.includes('email') ? 3 : 0) + (kinds.includes('name') || kinds.includes('first_name') ? 1 : 0)
      + (/send|submit|hantar|contact|enquir|hubungi/i.test(form.submitText) ? 1 : 0);
    if (score > bestScore) { best = form; bestScore = score; }
  }
  return best;
}

/** The verdict on a lead's pages, in reading order: the first page with a contact form decides. */
export function formVerdict(pages) {
  let challenge = null;
  for (const page of pages) {
    const pick = pickForm(formsInHtml(page.html));
    const onPage = pageCaptcha(page.html);
    if (!pick) {
      if (onPage === 'a Cloudflare check guards the page') challenge ??= page.url;
      continue;
    }
    const captcha = pick.captcha ?? onPage;
    if (captcha) return { status: 'captcha', url: page.url, detail: captcha };
    const kinds = [...new Set(pick.fields.map(classify).filter(Boolean))].join(', ');
    return { status: 'bot_can_submit', url: page.url, detail: `contact form with ${kinds}` };
  }
  if (challenge) return { status: 'captcha', url: challenge, detail: 'a Cloudflare check guards the page' };
  const built = pages.find((p) => SCRIPT_FORM.test(p.html));
  if (built) return { status: 'script_form', url: built.url, detail: 'the site draws its forms with script (' + SCRIPT_FORM.exec(built.html)[0] + '); not checked' };
  return { status: 'no_form', url: null, detail: `no contact form in the HTML of ${pages.length} page(s)` };
}

/** Contact-ish links on the homepage, for the check's read (the hub's researchWebsite): up to three, contact first. */
export function researchLinks(html, base) {
  const origin = new URL(base);
  const candidates = [];
  for (const m of String(html ?? '').matchAll(/<a\b[^<>]{0,2000}?href\s*=\s*["']([^"'#<>]{1,2000})["'][^<>]{0,2000}>([\s\S]{0,1000}?)<\/a>/gi)) {
    const label = decode(m[2].replace(/<[^<>]*>/g, ' '));
    if (!/contact|about|team|leadership|management|staff|people|hubungi|tentang/i.test(label + ' ' + m[1])) continue;
    try {
      const u = new URL(decode(m[1]), base);
      if (['http:', 'https:'].includes(u.protocol) && u.hostname.replace(/^www\./, '') === origin.hostname.replace(/^www\./, '')) {
        u.hash = '';
        candidates.push({ url: u.href, priority: /contact|hubungi/i.test(label + ' ' + m[1]) ? 0 : /team|leadership|management|staff|people/i.test(label + ' ' + m[1]) ? 1 : 2 });
      }
    } catch { /* not a link */ }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return [...new Set(candidates.map((c) => c.url))].slice(0, 3);
}

const FILE_TAIL = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|mjs|json|woff2?|ttf|pdf|mp4|webm)$/i;
const CONTACT_WORDS = /contact|hubungi|get-in-touch|getintouch|reach-us|enquir|inquir|联系|联络/i;
const ABOUT_WORDS = /about|tentang|company-profile|关于/i;

/** Contact pages to message through, for the delivery bot: same-site links, contact first, then about. */
export function deliveryLinks(html, pageUrl, max = 2) {
  const base = new URL(pageUrl);
  const host = base.hostname.replace(/^www\./i, '');
  const contact = [];
  const about = [];
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = m[1].trim();
    if (/^(mailto|tel|javascript|whatsapp):/i.test(href)) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./i, '') !== host) continue;
    if (FILE_TAIL.test(url.pathname)) continue;
    url.hash = '';
    const key = url.toString();
    if (key === base.toString() || contact.includes(key) || about.includes(key)) continue;
    const label = href + ' ' + m[2].replace(/<[^>]+>/g, ' ');
    if (CONTACT_WORDS.test(label)) contact.push(key);
    else if (ABOUT_WORDS.test(label)) about.push(key);
  }
  return [...contact, ...about].slice(0, max);
}

export function fillTemplate(text, lead) {
  return String(text ?? '')
    .replace(/\{\{\s*company_name\s*\}\}/g, lead.company_name ?? '')
    .replace(/\{\{\s*website\s*\}\}/g, lead.website ?? '')
    .replace(/\{\{\s*contact_name\s*\}\}/g, lead.contact_name || 'there');
}

const SUCCESS = /thank you|thanks for|thank-you|successfully|has been sent|have been sent|was sent|received your|we will (get back|contact|be in touch)|we'll (get back|be in touch)|message sent|terima kasih|berjaya dihantar|telah dihantar/i;
const REJECTED = /(error|failed|invalid|problem) (occurred|sending|submitting|with your)|please (fill|enter|complete|correct)|field is required|is required|try again|ralat|sila isi/i;

/** The answer a page gave after send: success words, an error, or nothing to go on. */
export function readOutcome(textAfter, textBefore, formGone, urlChanged) {
  // Only the lines the send added count: a footer that always says "thank you" proves nothing.
  const had = new Set(String(textBefore ?? '').split('\n').map((l) => l.trim()));
  const fresh = String(textAfter ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !had.has(l)).join('\n');
  if (/captcha|verify (?:that )?you are human|robot verification/i.test(fresh)) return { status: 'captcha', detail: 'blocked by CAPTCHA after submission; no retry attempted' };
  const ok = SUCCESS.exec(fresh);
  if (ok) return { status: 'sent', detail: `the site answered "${ok[0]}"` };
  const bad = REJECTED.exec(fresh);
  if (bad) return { status: 'failed', detail: `the form answered "${bad[0]}"` };
  if (formGone) return { status: 'sent', detail: 'the form was replaced after sending' };
  if (urlChanged) return { status: 'submitted_unconfirmed', detail: 'the page moved on after sending, with no thank-you text' };
  return { status: 'submitted_unconfirmed', detail: 'sent, but the page gave no clear answer' };
}
