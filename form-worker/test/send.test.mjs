// The send bot against a local fixture site (127.0.0.1, so no real company is contacted).
// Needs a Chrome or Edge on this machine (CHROME_PATH or the usual install); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, browserPath } from '../send.mjs';
import { startSite } from './fixture-site.mjs';

const skip = browserPath() ? false : 'no Chrome or Edge on this machine (set CHROME_PATH)';

const input = (site, extra = {}) => ({
  lead: { company_name: 'Fixture Sdn Bhd', website: site.url },
  sender: { name: 'Alex Gan', email: 'sender@example.com', phone: '0123456789', company: 'Eternalgy' },
  subject: 'Hello {{company_name}}',
  message: 'Hello {{company_name}}, we can help.',
  ...extra,
});

test('dry run fills the form and sends nothing', { skip }, async () => {
  const site = await startSite();
  try {
    const result = await deliver(input(site, { dry_run: true }));
    assert.equal(result.status, 'dry_run', result.detail);
    assert.ok(result.filled.length >= 3, JSON.stringify(result.filled));
    assert.equal(site.posts.length, 0);
  } finally {
    site.server.close();
  }
});

test('a real send posts the message once and reports sent', { skip }, async () => {
  const site = await startSite();
  try {
    const result = await deliver(input(site));
    assert.equal(result.status, 'sent', result.detail);
    assert.equal(site.posts.length, 1);
    const body = new URLSearchParams(site.posts[0]);
    assert.equal(body.get('name'), 'Alex Gan');
    assert.equal(body.get('email'), 'sender@example.com');
    assert.equal(body.get('message'), 'Hello Fixture Sdn Bhd, we can help.');
    assert.ok(result.screenshot?.startsWith('data:image/jpeg;base64,'));
  } finally {
    site.server.close();
  }
});

test('a website that is not the company own site is reported, not tried', async () => {
  const result = await deliver({ lead: { company_name: 'X', website: 'https://facebook.com/x' }, sender: { name: 'A', email: 'a@b.c' }, message: 'hi' });
  assert.equal(result.status, 'not_own_site');
});
