// The server, started on the real handlers/ folder, lists the global (ALL) handlers next to the country ones
// and queues a lookup for one with the domain as its keyword. No pretend worker answers, so nothing runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.API_KEY = 'test-api-key-0123456789';
process.env.HANDLERS_DIR = fileURLToPath(new URL('../handlers/', import.meta.url));
const { start } = await import('../server.mjs');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const api = { authorization: 'Bearer ' + process.env.API_KEY, 'content-type': 'application/json' };
test.after(() => server.close());

test('country=ALL lists the five global handlers; a country query does not include them', async () => {
  const all = (await (await fetch(`${base}/api/handlers?country=ALL`, { headers: api })).json()).handlers;
  assert.deepEqual(all.map((h) => h.id).sort(), ['ALL-crtsh/w1', 'ALL-dns/w1', 'ALL-ssl/w1', 'ALL-wayback/w1', 'ALL-youtube/w1']);
  for (const h of all) assert.equal(h.input, 'domain');
  const my = (await (await fetch(`${base}/api/handlers?country=MY`, { headers: api })).json()).handlers;
  assert.ok(my.length > 0);
  assert.ok(!my.some((h) => h.country === 'ALL'));
});

test('a lookup for a global handler carries the handler file and the domain as its keyword', async () => {
  const res = await fetch(`${base}/api/lookup`, { method: 'POST', headers: api, body: JSON.stringify({ callerId: 'test', taskDescription: 'Test lookup', handler: 'ALL-dns/w1', keyword: 'example.com', wait: 0 }) });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  assert.equal(job.payload.handler, 'ALL-dns/w1');
  assert.equal(job.payload.keyword, 'example.com');
  assert.equal(job.payload.source, fs.readFileSync(new URL('../handlers/ALL/ALL-dns.w1.mjs', import.meta.url), 'utf8'));
});
