// The whole round trip over HTTP: a caller posts a scan, a pretend worker
// claims it with its worker key and posts businesses back, the caller gets them.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.API_KEY = 'test-api-key-0123456789';
const { start, workerKey } = await import('../server.mjs');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const api = { authorization: 'Bearer ' + process.env.API_KEY, 'content-type': 'application/json' };
const wk = { authorization: 'Bearer ' + workerKey(), 'content-type': 'application/json' };
test.after(() => server.close());

const call = (path, headers, opts = {}) => fetch(base + path, { headers, ...opts });

test('health is open, everything else needs a key', async () => {
  assert.equal((await call('/health', {})).status, 200);
  assert.equal((await call('/api/workers', {})).status, 401);
});

test('a worker key reaches only the worker routes', async () => {
  assert.equal((await call('/api/workers', wk)).status, 403);
  assert.equal((await call('/api/worker/strategy', wk)).status, 200);
});

test('scan round trip', async () => {
  const posted = call('/api/scan', api, { method: 'POST', body: JSON.stringify({ keyword: 'factory', place: 'Taman Daya', max: 50, wait: 10 }) });
  const next = await call('/api/jobs/next?worker=pc-test&types=gmap.scan&wait=5', wk);
  assert.equal(next.status, 200);
  const { job } = await next.json();
  assert.equal(job.payload.keyword, 'factory');
  const result = { found: 1, businesses: [{ name: 'Acme Sdn Bhd', phone: '+60 7-000 0000' }] };
  const done = await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-test', ok: true, result }) });
  assert.equal(done.status, 200);
  const answer = await (await posted).json();
  assert.equal(answer.job.status, 'done');
  assert.equal(answer.job.result.businesses[0].name, 'Acme Sdn Bhd');
});

test('a result for a job lost to a restart is filed again', async () => {
  const id = 'abcdef123456';
  const body = { worker: 'pc-test', ok: true, result: { found: 0, businesses: [] }, payload: { keyword: 'shop', place: 'X', max: 5 } };
  assert.equal((await call(`/api/jobs/${id}/result`, wk, { method: 'POST', body: JSON.stringify(body) })).status, 200);
  const { job } = await (await call(`/api/scan/${id}`, api)).json();
  assert.equal(job.status, 'done');
});

test('a result for a lost job is not handed to a worker already waiting', async () => {
  const waiting = call('/api/jobs/next?worker=pc-idle&wait=3', wk);
  await new Promise((r) => setTimeout(r, 200));
  const id = 'fedcba654321';
  const body = { worker: 'pc-test', ok: true, result: { found: 0, businesses: [] }, payload: { keyword: 'shop', place: 'W', max: 5 } };
  assert.equal((await call(`/api/jobs/${id}/result`, wk, { method: 'POST', body: JSON.stringify(body) })).status, 200);
  assert.equal((await waiting).status, 204);
  const { job } = await (await call(`/api/scan/${id}`, api)).json();
  assert.equal(job.status, 'done');
  assert.equal(job.attempts, 1);
  assert.equal(job.worker, 'pc-test');
});

test('retryAfterMs rests the worker', async () => {
  const posted = await (await call('/api/scan', api, { method: 'POST', body: JSON.stringify({ keyword: 'cafe', place: 'Y' }) })).json();
  const { job } = await (await call('/api/jobs/next?worker=pc-rest&wait=1', wk)).json();
  assert.equal(job.id, posted.job.id);
  await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-rest', ok: false, error: 'blocked', retryAfterMs: 60_000 }) });
  await call('/api/scan', api, { method: 'POST', body: JSON.stringify({ keyword: 'cafe', place: 'Z' }) });
  assert.equal((await call('/api/jobs/next?worker=pc-rest&wait=1', wk)).status, 204);
});

test('package zip carries the worker key', async () => {
  const r = await call('/api/worker/package', api);
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes('LocalGmapWorker/app/worker.ps1'));
});
