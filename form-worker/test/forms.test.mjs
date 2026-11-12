// Unit checks for the form reading rules (no network, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, pickForm, formsInHtml, pageCaptcha, readOutcome, deliveryLinks, researchLinks, fillTemplate } from '../forms.mjs';
import { ownSiteUrl } from '../web.mjs';
import { planFill } from '../send.mjs';

test('classify reads English and Malay boxes', () => {
  assert.equal(classify({ tag: 'input', type: 'email', name: 'x', label: '' }), 'email');
  assert.equal(classify({ tag: 'input', type: 'text', name: 'emel', label: '' }), 'email');
  assert.equal(classify({ tag: 'input', type: 'tel', name: 'hp', label: '' }), 'phone');
  assert.equal(classify({ tag: 'input', type: 'text', name: 'company', label: '' }), 'company');
  assert.equal(classify({ tag: 'textarea', type: 'textarea', name: '', label: '' }), 'message');
  assert.equal(classify({ tag: 'input', type: 'checkbox', name: 'pdpa', label: 'I agree' }), 'consent');
  assert.equal(classify({ tag: 'input', type: 'text', name: 'zzz', label: '' }), null);
});

test('formsInHtml reads labels, required boxes and the submit text', () => {
  const [form] = formsInHtml('<form><label for="a">Email</label><input id="a" type="email" name="e" required><textarea name="m"></textarea><button>Send</button></form>');
  assert.equal(form.fields.length, 2);
  assert.equal(form.fields[0].label, 'Email');
  assert.equal(form.fields[0].required, true);
  assert.equal(form.submitText, 'Send');
});

test('pickForm skips newsletter and search forms', () => {
  const forms = formsInHtml('<form><input type="email" name="e"></form><form><input type="search" name="q"><textarea name="m"></textarea><input type="email" name="e"></form>');
  assert.equal(pickForm(forms), null);
});

test('pageCaptcha names what it sees', () => {
  assert.equal(pageCaptcha('<title>Just a moment...</title>'), 'a Cloudflare check guards the page');
  assert.equal(pageCaptcha('<div class="h-captcha"></div>'), 'hCaptcha');
  assert.equal(pageCaptcha('<p>hello</p>'), null);
});

test('readOutcome: success words, errors, and nothing clear', () => {
  assert.equal(readOutcome('Thank you for contacting us', '', false, true).status, 'sent');
  assert.equal(readOutcome('Thank you\nfooter', 'Thank you\nfooter', false, false).status, 'submitted_unconfirmed');
  assert.equal(readOutcome('Please fill this field', '', false, false).status, 'failed');
  assert.equal(readOutcome('', '', true, false).status, 'sent');
});

test('deliveryLinks: contact first, same site only, up to max', () => {
  const html = '<a href="/about">About</a><a href="https://other.com/contact">x</a><a href="/contact-us">Contact</a><a href="/logo.png">img</a>';
  assert.deepEqual(deliveryLinks(html, 'https://site.com.my/', 3), ['https://site.com.my/contact-us', 'https://site.com.my/about']);
});

test('researchLinks: contact before about, at most three', () => {
  const html = '<a href="/team">Team</a><a href="/contact">Hubungi</a><a href="/about">About</a><a href="/x">x</a>';
  assert.deepEqual(researchLinks(html, 'https://site.com.my/'), ['https://site.com.my/contact', 'https://site.com.my/team', 'https://site.com.my/about']);
});

test('ownSiteUrl refuses social pages and bare words', () => {
  assert.equal(ownSiteUrl('facebook.com/x'), null);
  assert.equal(ownSiteUrl('localhost'), null);
  assert.equal(ownSiteUrl('acme.com.my'), 'https://acme.com.my/');
});

test('fillTemplate fills the three placeholders and leaves others alone', () => {
  assert.equal(fillTemplate('Hi {{company_name}} ({{website}}) {{contact_name}} {{x}}', { company_name: 'Acme', website: 'https://acme.my' }),
    'Hi Acme (https://acme.my) there {{x}}');
});

test('planFill: first and last name from a full name, dash for unplaced required boxes', () => {
  const form = { id: 'f0', submitText: 'Send', captcha: null, fields: [
    { id: 'f0-0', tag: 'input', type: 'text', name: 'first_name', label: 'First name', required: true },
    { id: 'f0-1', tag: 'input', type: 'text', name: 'last_name', label: 'Last name', required: true },
    { id: 'f0-2', tag: 'input', type: 'email', name: 'email', label: 'Email', required: true },
    { id: 'f0-3', tag: 'textarea', type: 'textarea', name: 'message', label: 'Message', required: true },
    { id: 'f0-4', tag: 'input', type: 'text', name: 'q7', label: 'Code', required: true },
  ] };
  const steps = planFill(form, {
    lead: { company_name: 'Acme', website: 'https://acme.my' },
    sender: { name: 'Mr. Alex Gan', email: 'a@b.my', phone: '0123', company: 'Eternalgy' },
    message: 'Hello {{company_name}}', subject: 'Hi',
  });
  const byField = Object.fromEntries(steps.map((s) => [s.id, s]));
  assert.equal(byField['f0-0'].value, 'Alex');
  assert.equal(byField['f0-1'].value, 'Gan');
  assert.equal(byField['f0-2'].value, 'a@b.my');
  assert.equal(byField['f0-3'].value, 'Hello Acme');
  assert.equal(byField['f0-4'].as, 'unknown, required');
  assert.equal(byField['f0-4'].value, 'Eternalgy');
});
