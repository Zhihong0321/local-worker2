// Contact-form delivery: one lead in, one message delivered through the contact form on the
// lead's own website, and a record of what happened. Port of agy-lab/src/contact-form-delivery.ts
// (deliverNow, planFill, snapshot), minus the hub's database save: the hub keeps the record.
//
// Open the homepage, then its contact pages, find the form that is a contact form (a message box
// plus an email or phone box), fill the boxes a visitor would see, press its send button and read
// the answer. A form behind a captcha is left alone and reported as `captcha`. Boxes a visitor
// cannot see are never filled. Every failure comes back as a status, never a throw.
import fs from 'node:fs';
import path from 'node:path';
import { deliveryLinks, classify, pickForm, fillTemplate, readOutcome } from './forms.mjs';
import { ownSiteUrl } from './web.mjs';

// A delivery that is still running after this is killed; a send already pressed is then
// recorded as submitted_unconfirmed, never as failed.
export const DELIVER_MS = 3 * 60_000;
// Each browser call that the page does not answer within this gets an error instead of waiting forever.
const CALL_MS = 30_000;
const NAVIGATE_MS = 45_000;
const FALLBACK_PATHS = ['/contact', '/contact-us', '/contactus', '/hubungi-kami', '/contact.html'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser this PC or Mac uses: CHROME_PATH first, then the usual installs. */
export function browserPath(env = process.env) {
  const local = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null;
  const candidates = [
    env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    local,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

/** What goes in each box. Required boxes we cannot place get a neutral answer, and are reported. */
export function planFill(form, input) {
  const s = input.sender;
  // A title (Mr., Dr., Dato') belongs to the full name only: first and last name boxes get "Alex" and "Gan".
  const [first, ...rest] = s.name.trim().replace(/^(mr|mrs|ms|miss|mdm|dr|dato'?|datuk|encik|en|puan|pn|cik)\.?\s+/i, '').split(/\s+/);
  const kinds = form.fields.map(classify);
  const split = kinds.includes('first_name') || kinds.includes('last_name');
  const message = fillTemplate(input.message, input.lead);
  const subject = fillTemplate(input.subject || 'Enquiry', input.lead);
  const value = {
    email: s.email, phone: s.phone ?? '', company: s.company ?? '', website: s.website ?? '', subject,
    first_name: first ?? s.name, last_name: rest.join(' ') || first || s.name,
    name: split ? first ?? s.name : s.name, message, consent: 'on',
  };
  const steps = [];
  const radioDone = new Set();
  let messageDone = false;
  form.fields.forEach((f, i) => {
    const kind = kinds[i];
    const field = f.label || f.name || f.type;
    if (f.type === 'radio') {
      if (f.required && f.group && !radioDone.has(f.group)) { radioDone.add(f.group); steps.push({ id: f.id, field, as: 'first choice', action: 'check', value: 'on' }); }
      return;
    }
    if (f.type === 'checkbox') {
      if (kind === 'consent' || f.required) steps.push({ id: f.id, field, as: kind ?? 'required box', action: 'check', value: 'on' });
      return;
    }
    if (f.tag === 'select') {
      const choice = f.options?.[0];
      if (f.required && choice) steps.push({ id: f.id, field, as: 'first choice', action: 'select', value: choice });
      return;
    }
    if (kind === 'message') {
      if (messageDone) return;
      messageDone = true;
    }
    const v = kind ? value[kind] : '';
    if (v) steps.push({ id: f.id, field, as: kind, action: 'type', value: v });
    else if (f.required) steps.push({ id: f.id, field, as: 'unknown, required', action: 'type', value: kind === 'phone' ? '-' : s.company || '-' });
  });
  return steps;
}

/**
 * Runs inside each page and frame: tags every visible box and send button with data-cfd, and
 * reports the forms. Self-contained, because it is serialised into the browser.
 */
function snapshot(prefix, markFields = true) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    // Off-screen and aria-hidden boxes are traps for robots; a visitor never sees them.
    const onPage = r.right > 0 && r.bottom + window.scrollY > 0 && r.left < document.documentElement.scrollWidth;
    return r.width > 2 && r.height > 2 && onPage && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05
      && !el.closest('[aria-hidden="true"]');
  };
  const labelOf = (el) => {
    const id = el.getAttribute('id');
    const parts = [];
    if (id) document.querySelectorAll(`label[for="${CSS.escape(id)}"]`).forEach((l) => parts.push(l.textContent || ''));
    const wrap = el.closest('label');
    if (wrap) parts.push(wrap.textContent || '');
    parts.push(el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('title') || '');
    if (!parts.join('').trim()) {
      const prev = el.parentElement?.previousElementSibling ?? el.previousElementSibling;
      if (prev) parts.push((prev.textContent || '').slice(0, 80));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  };
  const html = document.documentElement.outerHTML.slice(0, 2_000_000);
  let pageCaptcha = null;
  if (/just a moment|attention required|verify you are human/i.test(document.title)) pageCaptcha = 'a Cloudflare check guards the page';
  else if (/google\.com\/recaptcha|recaptcha\/api\.js|grecaptcha|g-recaptcha/i.test(html)) pageCaptcha = 'reCAPTCHA';
  else if (/hcaptcha\.com|h-captcha/i.test(html)) pageCaptcha = 'hCaptcha';
  else if (/challenges\.cloudflare\.com|cf-turnstile/i.test(html)) pageCaptcha = 'Cloudflare Turnstile';
  else if (/friendlycaptcha|frc-captcha|mtcaptcha|captcha\.(png|jpg|php)|really-simple-captcha|wpcf7-quiz|si_captcha/i.test(html)) pageCaptcha = 'a captcha';

  const containers = Array.from(document.querySelectorAll('form'));
  // Forms built without a <form> (Wix, some page builders): the smallest block holding a message box and two or more inputs.
  document.querySelectorAll('textarea').forEach((ta) => {
    if (ta.closest('form')) return;
    let el = ta.parentElement;
    while (el && el !== document.body && el.querySelectorAll('input:not([type=hidden])').length < 2) el = el.parentElement;
    if (el && !containers.includes(el)) containers.push(el);
  });
  const forms = [];
  containers.forEach((c, fi) => {
    if (!visible(c)) return;
    const formId = `${prefix}f${fi}`;
    const fields = [];
    c.querySelectorAll('input, textarea, select').forEach((el, i) => {
      const type = (el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : '')).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
      if (!visible(el) && !(type === 'checkbox' || type === 'radio')) return;
      if ((type === 'checkbox' || type === 'radio') && !visible(el) && !(el.closest('label') && visible(el.closest('label')))) return;
      if (el.disabled || el.readOnly) return;
      const id = `${formId}-${i}`;
      if (markFields) el.setAttribute('data-cfd', id);
      const label = labelOf(el);
      const options = el.tagName === 'SELECT'
        ? Array.from(el.options).filter((o) => o.value && !o.disabled && !/select|choose|pilih|--/i.test(o.text)).map((o) => o.value)
        : undefined;
      fields.push({
        id, tag: el.tagName.toLowerCase(), type, name: el.getAttribute('name') || el.getAttribute('id') || '', label,
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(label),
        options, group: type === 'radio' ? el.getAttribute('name') || undefined : undefined,
      });
    });
    const buttons = Array.from(c.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a.button, .btn')).filter(visible);
    const send = buttons.find((b) => (b.getAttribute('type') || '').toLowerCase() === 'submit')
      ?? buttons.find((b) => /send|submit|hantar|hubungi|contact|enquir/i.test((b.textContent || '') + ' ' + (b.getAttribute('value') || '')))
      ?? buttons.find((b) => b.tagName === 'BUTTON' && !b.getAttribute('type'));
    if (send && markFields) send.setAttribute('data-cfd', `${formId}-send`);
    if (markFields) c.setAttribute('data-cfd-form', formId);
    const localCaptcha = c.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="captcha"], iframe[src*="turnstile"], img[src*="captcha"], input[name*="captcha" i]');
    const quiz = Array.from(c.querySelectorAll('label, span, p')).some((n) => /\d+\s*[+x×*-]\s*\d+\s*=|captcha|are you human|bukan robot/i.test(n.textContent || ''));
    forms.push({
      id: formId, fields,
      submitText: send ? ((send.textContent || '') + ' ' + (send.getAttribute('value') || '')).trim() : '',
      captcha: localCaptcha ? 'a captcha on the form' : quiz ? 'a question that checks for robots' : null,
      // A mailto: action hands the message to the visitor's mail app; it is never a web send.
      mailto: /^\s*mailto:/i.test(c.getAttribute('action') || '') || /^\s*mailto:/i.test(send?.closest('a')?.getAttribute('href') || send?.getAttribute('href') || ''),
    });
  });
  return { forms, pageCaptcha };
}

/**
 * Sends one message. Returns a DeliverResult; never throws.
 * input: { lead: {company_name, website, contact_name?}, sender, subject?, message, dry_run?, assist? }
 * assist(req) is the LLM step on the hub: it returns the fills for required boxes the script could
 * not place, or null (the script's own fill then stands).
 */
export async function deliver(input) {
  const out = {
    status: 'failed', website: input.lead?.website ?? '', form_url: null, detail: '', filled: [], pages_checked: [], screenshot: null, finished_at: '',
  };
  const done = (status, detail) => Object.assign(out, { status, detail, finished_at: new Date().toISOString() });
  const home = ownSiteUrl(input.lead?.website);
  if (!home) return done('not_own_site', 'the website is missing, or is a social page or marketplace rather than their own site');
  const exe = browserPath();
  if (!exe) return done('failed', 'no browser on this machine (set CHROME_PATH)');
  let browser = null;
  // Set just before the send button is pressed: from then on a failure means "maybe sent".
  let clicked = false;
  // Kills the browser when the whole delivery runs too long, which fails every pending call at once.
  const killer = setTimeout(() => { try { browser?.process()?.kill('SIGKILL'); } catch { /* already gone */ } }, DELIVER_MS);
  try {
    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: exe, headless: true, protocolTimeout: CALL_MS,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=en-GB'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    page.setDefaultTimeout(CALL_MS);
    page.setDefaultNavigationTimeout(NAVIGATE_MS);
    // A site's alert() or confirm() freezes the page until answered; answer it and keep its words for readOutcome.
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(String(d.message?.() ?? '')); d.accept().catch(() => {}); });

    let pageBlocked = false;
    const blocked = async (reason) => {
      out.form_url = page.url();
      try { out.screenshot = 'data:image/jpeg;base64,' + await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' }); } catch { /* keep existing screenshot */ }
      return done('captcha', `blocked by CAPTCHA: ${reason}; skipped without waiting or retrying`);
    };
    const open = async (url) => {
      pageBlocked = false;
      out.pages_checked.push(url);
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        await sleep(2500);
        // Challenge pages often return HTTP 403. Record CAPTCHA rather than unreachable.
        pageBlocked = /just a moment|attention required|verify you are human/i.test(await page.title());
        if (pageBlocked) return false;
        return !!res && res.status() < 400;
      } catch { return false; }
    };
    const look = async (markFields = true) => {
      const found = [];
      let pageCaptcha = null;
      for (const [n, frame] of page.frames().entries()) {
        try {
          const snap = await frame.evaluate(snapshot, `p${n}`, markFields);
          pageCaptcha ??= snap.pageCaptcha;
          for (const form of snap.forms) found.push({ frame, form, pageCaptcha: snap.pageCaptcha });
        } catch { /* a frame that went away while we looked */ }
      }
      return { found, pageCaptcha };
    };

    if (!(await open(home))) return pageBlocked ? await blocked('a page-level human verification check') : done('site_unreachable', `${home} did not load`);
    let homeHtml = '';
    try { homeHtml = await page.content(); } catch { /* keep going with fallbacks */ }
    const candidates = [home, ...deliveryLinks(homeHtml, page.url(), 3), ...FALLBACK_PATHS.map((p) => new URL(p, page.url()).toString())];
    const seen = new Set();
    let lastCaptcha = null;
    for (const url of candidates) {
      const key = url.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      if (url !== home && !(await open(url))) {
        if (pageBlocked) return await blocked('a page-level human verification check');
        continue;
      }
      const { found, pageCaptcha } = await look();
      const pick = pickForm(found.map((f) => f.form));
      if (!pick) { lastCaptcha ??= pageCaptcha; continue; }
      const hit = found.find((f) => f.form === pick);
      out.form_url = page.url();
      const shot = async () => {
        try {
          await hit.frame.evaluate((id) => document.querySelector(`[data-cfd-form="${id}"]`)?.scrollIntoView({ block: 'center' }), pick.id);
          await sleep(400);
          out.screenshot = 'data:image/jpeg;base64,' + await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });
        } catch { /* no screenshot, the result still stands */ }
      };
      const captcha = pick.captcha ?? hit.pageCaptcha ?? pageCaptcha;
      if (captcha) return await blocked(captcha);

      // The LLM step: where the script could not place a required box, the LLM says which sender value fits it.
      // Its answer is used only for those boxes and only with the listed values; anything else keeps the script's fill.
      const assisted = async (plan) => {
        const stuck = plan.some((s) => s.as === 'unknown, required');
        if (!stuck || !input.assist) return plan;
        const fills = await Promise.resolve()
          .then(() => input.assist({
            company_name: input.lead.company_name, website: input.lead.website, url: page.url(), submit_text: pick.submitText,
            fields: pick.fields.map(({ id, tag, type, name, label, required, options }) => ({ id, tag, type, name, label, required, options })),
          }))
          .catch(() => null);
        const s = input.sender;
        const values = {
          name: s.name, email: s.email, phone: s.phone ?? '-', company: s.company ?? '-', website: s.website ?? '-',
          subject: fillTemplate(input.subject || 'Enquiry', input.lead), dash: '-',
        };
        return plan.map((step) => {
          const fill = step.as === 'unknown, required' ? fills?.find((f) => f.id === step.id) : undefined;
          return fill && values[fill.use] !== undefined ? { ...step, as: `${fill.use} (assisted)`, value: values[fill.use] } : step;
        });
      };
      for (const step of await assisted(planFill(pick, input))) {
        const el = await hit.frame.$(`[data-cfd="${step.id}"]`);
        if (!el) continue;
        try {
          if (step.action === 'select') await hit.frame.select(`[data-cfd="${step.id}"]`, step.value);
          else if (step.action === 'check') {
            const checked = await el.evaluate((e) => e.checked);
            if (!checked) await el.evaluate((e) => (e.closest('label') ?? e).click());
          } else {
            // The value goes on this box itself, never through the keyboard: a chat widget that
            // takes focus while typing would get the keys, and each line break would send there.
            await el.evaluate((e, value) => {
              e.focus();
              const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
              e.dispatchEvent(new Event('input', { bubbles: true }));
              e.dispatchEvent(new Event('change', { bubbles: true }));
              e.blur();
            }, step.value);
          }
          out.filled.push({ field: step.field, as: step.as });
        } catch (err) { out.filled.push({ field: step.field, as: `${step.as} (could not fill: ${String(err.message).slice(0, 80)})` }); }
      }
      await shot();
      if (input.dry_run) return done('dry_run', `filled the form on ${out.form_url}; not sent (dry run)`);

      const before = await hit.frame.evaluate(() => document.body.innerText).catch(() => '');
      const urlBefore = page.url();
      const sendBtn = await hit.frame.$(`[data-cfd="${pick.id}-send"]`);
      clicked = true;
      if (sendBtn) await sendBtn.click().catch(() => sendBtn.evaluate((b) => b.click()));
      else await hit.frame.evaluate((id) => {
        const f = document.querySelector(`[data-cfd-form="${id}"]`);
        if (f instanceof HTMLFormElement) f.requestSubmit();
      }, pick.id);
      await sleep(7000);
      const frame = page.frames().includes(hit.frame) ? hit.frame : page.mainFrame();
      const after = await frame.evaluate(() => document.body.innerText).catch(() => '');
      const afterWords = [after, ...dialogs].join('\n');
      const afterLook = await look(false);
      const afterCaptcha = afterLook.pageCaptcha ?? afterLook.found.find((f) => f.form.captcha)?.form.captcha;
      if (afterCaptcha && readOutcome(afterWords, before, false, false).status !== 'sent') return await blocked(afterCaptcha);
      const formGone = await frame.evaluate((id) => {
        const f = document.querySelector(`[data-cfd-form="${id}"]`);
        return !f || f.getBoundingClientRect().height < 5;
      }, pick.id).catch(() => true);
      const outcome = readOutcome(afterWords, before, formGone, page.url() !== urlBefore);
      try { out.screenshot = 'data:image/jpeg;base64,' + await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' }); } catch { /* keep the filled shot */ }
      return done(outcome.status, outcome.detail);
    }
    if (lastCaptcha) return await blocked(lastCaptcha);
    return done('no_form', `no contact form on ${out.pages_checked.length} page(s) checked`);
  } catch (err) {
    const why = String(err?.message ?? err).slice(0, 300);
    if (clicked) return done('submitted_unconfirmed', `the send button was pressed, then the page stopped answering (${why}); not resent`);
    return done('failed', why);
  } finally {
    clearTimeout(killer);
    if (browser) {
      // A browser that will not close is killed, so no headless Chrome is left behind on this PC.
      await Promise.race([browser.close().catch(() => {}), sleep(5_000)]);
      try { browser.process()?.kill('SIGKILL'); } catch { /* already closed */ }
    }
  }
}
