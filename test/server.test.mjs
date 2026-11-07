// The whole round trip over HTTP: a caller posts a scan, a pretend worker
// claims it with its worker key and posts businesses back, the caller gets them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.API_KEY = 'test-api-key-0123456789';
process.env.HANDLERS_DIR = fileURLToPath(new URL('./fixtures/handlers/', import.meta.url));
process.env.HANDLER_CHECK_INTERVAL_MS = '0';
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

test('the API page is open and describes the scan route', async () => {
  const r = await call('/docs', {});
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /\/api\/scan/);
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

test('fetch round trip: only a worker asking for web.fetch gets it', async () => {
  const posted = call('/api/fetch', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/a', worker: 'pc-fetch' }) });
  await new Promise((r) => setTimeout(r, 100));
  // Earlier tests leave scans in the queue: a scan-only worker may get one of those, never the fetch.
  const scanOnly = await call('/api/jobs/next?worker=pc-fetch&types=gmap.scan&wait=0', wk);
  if (scanOnly.status === 200) assert.equal((await scanOnly.json()).job.type, 'gmap.scan');
  const next = await call('/api/jobs/next?worker=pc-fetch&types=gmap.scan,web.fetch&wait=1', wk);
  const { job } = await next.json();
  assert.equal(job.type, 'web.fetch');
  assert.deepEqual(job.payload, { url: 'https://example.com/a', format: 'markdown', mainContent: true, worker: 'pc-fetch' });
  assert.equal(job.timeoutMs, 60_000);
  const result = { url: job.payload.url, status: 200, title: 'A', content: '# A' };
  await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-fetch', ok: true, result }) });
  const answer = await (await posted).json();
  assert.equal(answer.job.status, 'done');
  assert.equal(answer.job.result.content, '# A');
  assert.equal((await (await call(`/api/fetch/${job.id}`, api)).json()).job.status, 'done');
});

test('fetch passes keepErrors and headers only when asked', async () => {
  const posted = call('/api/fetch', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/k', worker: 'pc-flags', keepErrors: true, headers: true }) });
  await new Promise((r) => setTimeout(r, 100));
  const { job } = await (await call('/api/jobs/next?worker=pc-flags&types=web.fetch&wait=1', wk)).json();
  assert.deepEqual(job.payload, { url: 'https://example.com/k', format: 'markdown', mainContent: true, keepErrors: true, headers: true, worker: 'pc-flags' });
  const result = { url: job.payload.url, status: 404, content: 'Not found', headers: { server: 'x' }, redirects: [] };
  await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-flags', ok: true, result }) });
  assert.deepEqual((await (await posted).json()).job.result, result);
  // false is the same as left out: the payload is the one a fetch always had.
  const plain = call('/api/fetch', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/p', worker: 'pc-flags', keepErrors: false, headers: false }) });
  await new Promise((r) => setTimeout(r, 100));
  const { job: other } = await (await call('/api/jobs/next?worker=pc-flags&types=web.fetch&wait=1', wk)).json();
  assert.deepEqual(other.payload, { url: 'https://example.com/p', format: 'markdown', mainContent: true, worker: 'pc-flags' });
  await call(`/api/jobs/${other.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-flags', ok: false, error: 'the site answered HTTP 404' }) });
  assert.equal((await (await plain).json()).job.error, 'the site answered HTTP 404');
});

test('fetch checks its input', async () => {
  for (const body of [{}, { url: 'ftp://x.com/' }, { url: 'nope' }, { url: 'https://x.com/', format: 'pdf' }, { url: 'https://x.com/', timeoutMs: 1000 },
    { url: 'https://x.com/', keepErrors: 'yes' }, { url: 'https://x.com/', headers: 1 }]) {
    assert.equal((await call('/api/fetch', api, { method: 'POST', body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
  }
});

test('fetch with wait 0 answers at once, and a worker Google is resting still fetches', async () => {
  const scan = await (await call('/api/scan', api, { method: 'POST', body: JSON.stringify({ keyword: 'cafe', place: 'V', worker: 'pc-cool' }) })).json();
  const { job: s } = await (await call('/api/jobs/next?worker=pc-cool&wait=1', wk)).json();
  assert.equal(s.id, scan.job.id);
  await call(`/api/jobs/${s.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-cool', ok: false, error: 'blocked', retryAfterMs: 60_000 }) });
  const r = await call('/api/fetch', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/b', worker: 'pc-cool', wait: 0 }) });
  assert.equal(r.status, 202);
  const posted = (await r.json()).job;
  const { job } = await (await call('/api/jobs/next?worker=pc-cool&types=gmap.scan,web.fetch&wait=1', wk)).json();
  assert.equal(job.id, posted.id);
});

test('a fetch result lost to a restart is filed again as a fetch', async () => {
  const id = '0123456789ab';
  const body = { worker: 'pc-test', type: 'web.fetch', ok: true, result: { content: 'x' }, payload: { url: 'https://example.com/', format: 'text' } };
  assert.equal((await call(`/api/jobs/${id}/result`, wk, { method: 'POST', body: JSON.stringify(body) })).status, 200);
  const { job } = await (await call(`/api/fetch/${id}`, api)).json();
  assert.equal(job.type, 'web.fetch');
  assert.equal(job.status, 'done');
});

test('shot round trip: opt-in, defaults in the payload, the image back unchanged', async () => {
  const posted = call('/api/shot', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/s', worker: 'pc-shot', find: '  Call us  ' }) });
  await new Promise((r) => setTimeout(r, 100));
  // A worker that does not ask for web.shot never gets one.
  for (const types of ['', '&types=gmap.scan,web.fetch,site.audit,site.lookup']) {
    const other = await call(`/api/jobs/next?worker=pc-shot&wait=0${types}`, wk);
    if (other.status === 200) assert.notEqual((await other.json()).job.type, 'web.shot');
  }
  const { job } = await (await call('/api/jobs/next?worker=pc-shot&types=web.fetch,web.shot&wait=1', wk)).json();
  assert.equal(job.type, 'web.shot');
  assert.deepEqual(job.payload, { url: 'https://example.com/s', device: 'desktop', waitMs: 1500, quality: 72, find: 'Call us', worker: 'pc-shot' });
  assert.equal(job.timeoutMs, 60_000);
  assert.equal(Date.parse(job.leaseUntil) - Date.parse(job.startedAt), 90_000);
  const result = { url: job.payload.url, finalUrl: job.payload.url, status: 404, device: 'desktop', found: true, blocked: false, image: '/9j/AAA', width: 1280, height: 760 };
  await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-shot', type: 'web.shot', ok: true, result }) });
  const answer = await (await posted).json();
  assert.equal(answer.job.status, 'done');
  assert.deepEqual(answer.job.result, result);
  assert.equal((await (await call(`/api/shot/${job.id}`, api)).json()).job.result.image, '/9j/AAA');
  const listed = (await (await call('/api/scans?type=web.shot', api)).json()).jobs.find((j) => j.id === job.id);
  assert.equal(listed.blocked, false);
  assert.equal(listed.result, undefined);
});

test('shot checks its input; mobile and options pass through; DELETE cancels', async () => {
  for (const body of [{}, { url: 'ftp://x.com/' }, { url: 'nope' }, { url: 'https://x.com/', device: 'tablet' }, { url: 'https://x.com/', find: 3 },
    { url: 'https://x.com/', find: 'x'.repeat(501) }, { url: 'https://x.com/', waitMs: -1 }, { url: 'https://x.com/', waitMs: 30001 },
    { url: 'https://x.com/', quality: 0 }, { url: 'https://x.com/', quality: 101 }, { url: 'https://x.com/', timeoutMs: 1000 }]) {
    assert.equal((await call('/api/shot', api, { method: 'POST', body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
  }
  const r = await call('/api/shot', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/m', device: 'mobile', waitMs: 0, quality: 90, wait: 0, worker: 'pc-shot-m' }) });
  assert.equal(r.status, 202);
  const { job } = await r.json();
  assert.deepEqual(job.payload, { url: 'https://example.com/m', device: 'mobile', waitMs: 0, quality: 90, worker: 'pc-shot-m' });
  const cancelled = await call(`/api/shot/${job.id}`, api, { method: 'DELETE' });
  assert.equal((await cancelled.json()).job.error, 'cancelled by the caller');
  assert.equal((await call('/api/jobs/next?worker=pc-shot-m&types=web.shot&wait=0', wk)).status, 204);
});

test('a shot no worker takes fails at its timeoutMs', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const isolated = await import('../server.mjs?shot-clock');
  const service = await isolated.start(0);
  t.after(() => service.close());
  const request = (route, body) => fetch(`http://localhost:${service.address().port}${route}`, {
    headers: api, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const queued = (await (await request('/api/shot', { url: 'https://example.com/', timeoutMs: 20000, wait: 0 })).json()).job;
  for (let i = 0; i < 3; i++) t.mock.timers.tick(5000);
  assert.equal((await (await request(`/api/shot/${queued.id}`)).json()).job.status, 'pending');
  for (let i = 0; i < 2; i++) t.mock.timers.tick(5000);
  const failed = (await (await request(`/api/shot/${queued.id}`)).json()).job;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'no worker claimed it within 20 s');
});

test('a shot result lost to a restart is filed again as a shot', async () => {
  const id = '0123456789cd';
  const body = { worker: 'pc-test', type: 'web.shot', ok: true, result: { blocked: true, image: null }, payload: { url: 'https://example.com/', device: 'mobile' } };
  assert.equal((await call(`/api/jobs/${id}/result`, wk, { method: 'POST', body: JSON.stringify(body) })).status, 200);
  const { job } = await (await call(`/api/shot/${id}`, api)).json();
  assert.equal(job.type, 'web.shot');
  assert.equal(job.result.blocked, true);
});

test('audit round trip waits by default and preserves the report unchanged', async () => {
  const posted = call('/api/audit', api, { method: 'POST', body: JSON.stringify({ url: ' HTTPS://EXAMPLE.COM:443 ', worker: 'pc-audit' }) });
  const next = await call('/api/jobs/next?worker=pc-audit&types=site.audit&wait=5', wk);
  assert.equal(next.status, 200);
  const { job } = await next.json();
  assert.equal(job.type, 'site.audit');
  assert.deepEqual(job.payload, { url: 'https://example.com/', maxPages: 5, botTest: true, worker: 'pc-audit' });
  assert.equal(job.timeoutMs, 180_000);
  assert.equal(Date.parse(job.leaseUntil) - Date.parse(job.startedAt), 210_000);
  const result = {
    scores: { seo: 82, geo: 73, groups: { metadata: 90 } },
    checks: [{ id: 'title', group: 'metadata', title: 'Page title', status: 'pass', score: 100, weight: 2, detail: 'Present', data: { title: 'Example', extra: [null, false] } }],
    pages: [{ url: job.payload.url, status: 200 }], tookMs: 1234, extra: { preserve: true },
  };
  assert.equal((await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-audit', type: 'site.audit', ok: true, result }) })).status, 200);
  const response = await posted;
  assert.equal(response.status, 200);
  const { job: done } = await response.json();
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, result);
  assert.deepEqual((await (await call(`/api/jobs/${job.id}`, api)).json()).job.result, result);
  assert.deepEqual((await (await call(`/api/audit/${job.id}`, api)).json()).job.result, result);
});

test('audit checks its input and requires a caller key', async () => {
  assert.equal((await call('/api/audit', {}, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call('/api/audit', wk, { method: 'POST', body: '{}' })).status, 403);
  const invalid = [
    {}, { url: '   ' }, { url: 'ftp://example.com/' }, { url: 'nope' }, { url: 'https://example.com/' + 'x'.repeat(2048) },
    ...[0, 26, 1.5, 'invalid'].map((maxPages) => ({ url: 'https://example.com/', maxPages })),
    ...['false', 0, {}, []].map((botTest) => ({ url: 'https://example.com/', botTest })),
    ...[29999, 600001, 'invalid'].map((timeoutMs) => ({ url: 'https://example.com/', timeoutMs })),
  ];
  for (const body of invalid) {
    const response = await call('/api/audit', api, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('audit requires explicit opt-in and respects worker pinning', async () => {
  const response = await call('/api/audit', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/', worker: 'pc-audit-opt', wait: 0 }) });
  assert.equal(response.status, 202);
  const { job: queued } = await response.json();
  assert.equal(queued.status, 'pending');
  // Earlier tests can leave scans queued; default polls may take those, never an audit.
  for (const types of ['', '&types=gmap.scan,web.fetch']) {
    const other = await call(`/api/jobs/next?worker=pc-audit-opt&wait=0${types}`, wk);
    if (other.status === 200) assert.notEqual((await other.json()).job.type, 'site.audit');
    else assert.equal(other.status, 204);
  }
  assert.equal((await call('/api/jobs/next?worker=pc-audit-other&types=site.audit&wait=0', wk)).status, 204);
  const { job } = await (await call('/api/jobs/next?worker=pc-audit-opt&types=web.fetch,site.audit&wait=0', wk)).json();
  assert.equal(job.id, queued.id);
  await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-audit-opt', ok: true, result: {} }) });
});

test('audit accepts boundary options and wait 0 in the query or body', async () => {
  for (const [maxPages, timeoutMs, query] of [[1, 30000, '?wait=0'], [25, 600000, '']]) {
    const body = { url: 'http://example.com', maxPages, timeoutMs, botTest: false, worker: ' pc-audit-options ', ...(query ? {} : { wait: 0 }) };
    const response = await call('/api/audit' + query, api, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    assert.equal(job.timeoutMs, timeoutMs);
    assert.deepEqual(job.payload, { url: 'http://example.com/', maxPages, botTest: false, worker: 'pc-audit-options' });
    assert.equal((await call(`/api/jobs/${job.id}`, api, { method: 'DELETE' })).status, 200);
  }
});

test('audit wait seconds returns a pending job that can be polled through completion', async () => {
  const response = await call('/api/audit', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/', worker: 'pc-audit-wait', wait: 0.01 }) });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  const polling = call(`/api/jobs/${job.id}?wait=5`, api);
  const claimed = (await (await call('/api/jobs/next?worker=pc-audit-wait&types=site.audit&wait=0', wk)).json()).job;
  assert.equal(claimed.id, job.id);
  await call(`/api/jobs/${job.id}/result`, wk, { method: 'POST', body: JSON.stringify({ worker: 'pc-audit-wait', ok: false, error: 'audit failed' }) });
  const done = (await (await polling).json()).job;
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'audit failed');
});

test('an audit result lost to a restart is filed again without waking an idle worker', async () => {
  const waiting = call('/api/jobs/next?worker=pc-audit-idle&types=site.audit&wait=1', wk);
  await new Promise((r) => setTimeout(r, 100));
  const id = 'a0d170123456';
  const body = { worker: 'pc-audit-restart', type: 'site.audit', ok: true, payload: { url: 'https://example.com/', maxPages: 3, botTest: false }, result: { scores: { seo: 80, geo: 70, groups: {} }, checks: [], pages: [], tookMs: 42 } };
  assert.equal((await call(`/api/jobs/${id}/result`, wk, { method: 'POST', body: JSON.stringify(body) })).status, 200);
  assert.equal((await waiting).status, 204);
  const { job } = await (await call(`/api/jobs/${id}`, api)).json();
  assert.equal(job.type, 'site.audit');
  assert.equal(job.status, 'done');
  assert.equal(job.timeoutMs, 180000);
  assert.equal(job.attempts, 1);
  assert.equal(job.worker, body.worker);
  assert.deepEqual(job.payload, body.payload);
  assert.deepEqual(job.result, body.result);
});

test('audit queue deadlines and lease grace use its own timeout', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const isolated = await import('../server.mjs?audit-clock');
  const service = await isolated.start(0);
  t.after(() => service.close());
  const request = (route, headers = api, body) => fetch(`http://localhost:${service.address().port}${route}`, {
    headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const queued = (await (await request('/api/audit', api, { url: 'https://example.com/', timeoutMs: 30000, wait: 0 })).json()).job;
  const pinned = (await (await request('/api/audit', api, { url: 'https://example.com/', timeoutMs: 60000, worker: 'missing-audit', wait: 0 })).json()).job;
  for (let i = 0; i < 7; i++) t.mock.timers.tick(5000);
  const failed = (await (await request(`/api/jobs/${queued.id}`)).json()).job;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'no worker claimed it within 30 s');
  assert.equal((await (await request(`/api/jobs/${pinned.id}`)).json()).job.status, 'pending');
  for (let i = 0; i < 6; i++) t.mock.timers.tick(5000);
  assert.equal((await (await request(`/api/jobs/${pinned.id}`)).json()).job.error, 'worker missing-audit did not claim it within 60 s');
  const active = (await (await request('/api/audit', api, { url: 'https://example.com/', timeoutMs: 30000, worker: 'audit-lease', wait: 0 })).json()).job;
  const leased = (await (await request('/api/jobs/next?worker=audit-lease&types=site.audit&wait=0', wk)).json()).job;
  assert.equal(leased.id, active.id);
  assert.equal(Date.parse(leased.leaseUntil) - Date.parse(leased.startedAt), 60000);
  for (let i = 0; i < 12; i++) t.mock.timers.tick(5000);
  assert.equal((await (await request(`/api/jobs/${active.id}`)).json()).job.status, 'running');
  t.mock.timers.tick(5000);
  assert.equal((await (await request(`/api/jobs/${active.id}`)).json()).job.status, 'pending');
  const reclaimed = (await (await request('/api/jobs/next?worker=audit-lease&types=site.audit&wait=0', wk)).json()).job;
  assert.equal(reclaimed.id, active.id);
  assert.equal(reclaimed.attempts, 2);
  await request(`/api/jobs/${active.id}/result`, wk, { worker: 'audit-lease', ok: true, result: {} });
});

test('package zip carries the worker key', async () => {
  const r = await call('/api/worker/package', api);
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes('LocalGmapWorker/app/worker.ps1'));
  for (const name of ['audit.py', 'audit_ai_access.py', 'audit_content.py', 'audit_onpage.py', 'audit_schema.py']) {
    assert.ok(buf.includes('LocalGmapWorker/app/' + name), name);
  }
  assert.ok(!buf.includes('linkedin'), 'the LinkedIn scraper is gone');
});

const fixtureIndex = JSON.parse(fs.readFileSync(new URL('./fixtures/handlers/index.json', import.meta.url)));
const lookupA = 'MY-cims.cidb.gov.my/w1';
const lookupB = 'MY-cims.cidb.gov.my/w2';
const lookupC = 'SG-sgx.com/w1';
const postLookup = (handler = lookupA, extra = {}) => call('/api/lookup', api, {
  method: 'POST', body: JSON.stringify({ handler, keyword: 'Gamuda', wait: 0, ...extra }),
});
const pollLookup = (worker, wait = 0) => call(`/api/jobs/next?worker=${worker}&types=site.lookup&wait=${wait}`, wk);
const answerLookup = (job, answer, extra = {}) => call(`/api/jobs/${job.id}/result`, wk, {
  method: 'POST', body: JSON.stringify({ worker: job.worker, type: 'site.lookup', ok: true, result: { meta: { tier: 2 }, result: answer }, ...extra }),
});
const notFound = { status: 'not_found', reason: null, records: [], source_url: 'https://cims.cidb.gov.my/', excerpt: '' };

test('handler index has filters, no source and initially unknown health', async () => {
  const { handlers } = await (await call('/api/handlers', api)).json();
  assert.equal(handlers.length, 5);
  for (const handler of handlers) {
    assert.equal('source' in handler, false);
    assert.deepEqual(handler.health, { state: 'unknown', last_ok: null, last_fail: null, last_reason: null, broken_reason: null, checked_at: null });
  }
  const filtered = await (await call('/api/handlers?country=MY&host=cims.cidb.gov.my', api)).json();
  assert.deepEqual(filtered.handlers.map((h) => h.id), [lookupA, lookupB]);
  assert.deepEqual((await (await call('/api/handlers?country=SG&host=cims.cidb.gov.my', api)).json()).handlers, []);
  assert.equal((await call('/api/handlers', wk)).status, 403);
  assert.equal((await call('/api/lookup', wk, { method: 'POST', body: '{}' })).status, 403);
  assert.deepEqual(await (await call('/api/handlers/check', api)).json(), { run: null });
});

test('lookup round trip waits by default and includes source, version and result provenance', async () => {
  const posted = postLookup(lookupA, { wait: undefined, worker: 'pc-lookup' });
  const response = await pollLookup('pc-lookup', 5);
  assert.equal(response.status, 200);
  const { job } = await response.json();
  const entry = fixtureIndex.handlers.find((h) => h.id === lookupA);
  assert.equal(job.type, 'site.lookup');
  assert.equal(job.timeoutMs, 150000);
  assert.equal(Date.parse(job.leaseUntil) - Date.parse(job.startedAt), 180000);
  assert.deepEqual(job.payload, {
    handler: lookupA, version: entry.version, host: entry.host, keyword: 'Gamuda', worker: 'pc-lookup',
    source: fs.readFileSync(new URL(`./fixtures/handlers/${entry.file}`, import.meta.url), 'utf8'),
  });
  const returned = { status: 'found', reason: null, records: [{ name: 'Gamuda', extra: ['preserve', null] }], source_url: entry.source_url, excerpt: 'Gamuda' };
  assert.equal((await answerLookup(job, returned)).status, 200);
  const responseToCaller = await posted;
  assert.equal(responseToCaller.status, 200);
  const { job: done } = await responseToCaller.json();
  assert.equal(done.status, 'done');
  assert.equal(done.result.handler, lookupA);
  assert.equal(done.result.version, entry.version);
  assert.equal(done.result.worker, 'pc-lookup');
  assert.equal(typeof done.result.tookMs, 'number');
  assert.deepEqual(done.result.result, returned);
  assert.deepEqual(done.result.meta, { tier: 2 });
  assert.equal((await (await call(`/api/lookup/${job.id}`, api)).json()).job.status, 'done');
  assert.equal((await call(`/api/lookup/${job.id}`, api, { method: 'DELETE' })).status, 409);
  const { handlers } = await (await call('/api/handlers?country=MY', api)).json();
  assert.equal(handlers[0].health.state, 'ok');
  assert.ok(handlers[0].health.last_ok);
});

test('lookup rejects unknown, non-runnable and invalid inputs without queuing', async () => {
  assert.equal((await postLookup('missing/w1')).status, 404);
  for (const tier of [3, 4]) {
    const entry = fixtureIndex.handlers.find((h) => h.tier === tier);
    const response = await postLookup(entry.id);
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.tier, tier);
    assert.deepEqual(body.tier4, entry.tier4);
    assert.deepEqual(body.browser_steps, entry.browser_steps);
  }
  for (const keyword of ['', '   ', 'x'.repeat(201)]) assert.equal((await postLookup(lookupA, { keyword })).status, 422);
  for (const timeoutMs of [9999, 300001, 15000.5, 'invalid']) assert.equal((await postLookup(lookupA, { timeoutMs })).status, 400);
  assert.equal((await call('/api/lookup/000000000000', api)).status, 404);
});

test('lookup requires opt-in, respects worker pinning and runs while Google rests', async () => {
  const posted = await postLookup(lookupA, { worker: 'pc-cool' });
  assert.equal(posted.status, 202);
  const { job: queued } = await posted.json();
  assert.equal((await call('/api/jobs/next?worker=pc-cool&wait=0', wk)).status, 204);
  assert.equal((await pollLookup('pc-other')).status, 204);
  const { job } = await (await pollLookup('pc-cool')).json();
  assert.equal(job.id, queued.id);
  assert.equal((await answerLookup(job, notFound)).status, 200);
});

test('same-host lookup waits across workers while another host runs, then wakes a waiting worker', async () => {
  const first = (await (await postLookup(lookupA, { worker: 'pc-host-a' })).json()).job;
  const second = (await (await postLookup(lookupB, { worker: 'pc-host-b' })).json()).job;
  const third = (await (await postLookup(lookupC, { worker: 'pc-host-b' })).json()).job;
  const { job: running } = await (await pollLookup('pc-host-a')).json();
  assert.equal(running.id, first.id);
  const { job: otherHost } = await (await pollLookup('pc-host-b')).json();
  assert.equal(otherHost.id, third.id);
  assert.equal((await pollLookup('pc-host-b')).status, 204);
  const waiting = pollLookup('pc-host-b', 3);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await answerLookup(running, notFound)).status, 200);
  const woke = await waiting;
  assert.equal(woke.status, 200);
  const { job: next } = await woke.json();
  assert.equal(next.id, second.id);
  await answerLookup(next, notFound);
  await answerLookup(otherHost, notFound);
});

test('cancelling a lookup releases its host to a waiting worker', async () => {
  const first = (await (await postLookup(lookupA, { worker: 'pc-cancel-a' })).json()).job;
  const second = (await (await postLookup(lookupB, { worker: 'pc-cancel-b' })).json()).job;
  await pollLookup('pc-cancel-a');
  const waiting = pollLookup('pc-cancel-b', 3);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call(`/api/lookup/${first.id}`, api, { method: 'DELETE' })).status, 200);
  const { job } = await (await waiting).json();
  assert.equal(job.id, second.id);
  await answerLookup(job, notFound);
});

test('layout_changed is a normal result that immediately marks handler health broken', async () => {
  await postLookup(lookupA, { worker: 'pc-layout' });
  const { job } = await (await pollLookup('pc-layout')).json();
  const answer = { status: 'couldnt_check', reason: 'layout_changed', records: [] };
  await answerLookup(job, answer);
  const done = (await (await call(`/api/lookup/${job.id}`, api)).json()).job;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result.result, answer);
  const entry = (await (await call('/api/handlers', api)).json()).handlers.find((h) => h.id === lookupA);
  assert.equal(entry.health.state, 'broken');
  assert.equal(entry.health.last_reason, 'layout_changed');
  assert.ok(entry.health.last_ok);
  assert.equal(entry.health.last_fail, done.finishedAt);
  assert.equal(entry.health.checked_at, done.finishedAt);
});

test('a failed lookup is recorded but does not judge; broken stays until a canary passes', async () => {
  for (const failure of [true, false]) {
    await postLookup(lookupA, { worker: 'pc-health' });
    const { job } = await (await pollLookup('pc-health')).json();
    await answerLookup(job, notFound, failure ? { ok: false, error: 'handler threw: test error' } : {});
    const entry = (await (await call('/api/handlers', api)).json()).handlers.find((h) => h.id === lookupA);
    // The layout_changed test above left it broken; the canary test below clears it.
    assert.equal(entry.health.state, 'broken');
    assert.equal(entry.health.broken_reason, 'layout_changed');
    assert.equal(entry.health.last_reason, failure ? 'handler threw: test error' : null);
    assert.ok(entry.health.last_fail);
  }
});

test('lookup result after restart is filed without source and fills omitted provenance', async () => {
  const id = '789abcdef012';
  const payload = { handler: lookupA, version: '0123456789ab', host: 'cims.cidb.gov.my', keyword: 'Gamuda' };
  const body = { type: 'site.lookup', worker: 'pc-restart', payload, ok: true, result: { tookMs: 42, meta: {}, result: notFound } };
  assert.equal((await call(`/api/jobs/${id}/result`, wk, { method: 'POST', body: JSON.stringify(body) })).status, 200);
  const { job } = await (await call(`/api/lookup/${id}`, api)).json();
  assert.equal(job.status, 'done');
  assert.equal(job.type, 'site.lookup');
  assert.equal(job.timeoutMs, 150000);
  assert.deepEqual(job.payload, payload);
  assert.deepEqual(job.result, { ...body.result, handler: lookupA, version: payload.version, worker: body.worker });
});

test('canaries require both correct sides, preserve failures and reject overlapping checks', async () => {
  const response = await call('/api/handlers/check', api, { method: 'POST', body: '{}' });
  assert.equal(response.status, 202);
  const { run } = await response.json();
  assert.equal(run.handlers.length, 3);
  assert.deepEqual(run.counts, { ok: 0, broken: 0, pending: 3 });
  assert.equal((await call('/api/handlers/check', api, { method: 'POST', body: '{}' })).status, 409);
  for (let i = 0; i < 6; i++) {
    const { job } = await (await pollLookup('pc-canary')).json();
    const entry = fixtureIndex.handlers.find((h) => h.id === job.payload.handler);
    const side = job.payload.keyword === entry.canary.found ? 'found' : 'not_found';
    assert.deepEqual(Object.keys(job.payload).sort(), ['handler', 'host', 'keyword', 'source', 'version']);
    const answer = { status: side, reason: null, records: side === 'found' && entry.id !== lookupB ? [{ name: job.payload.keyword }] : [] };
    await answerLookup(job, answer);
  }
  const { run: finished } = await (await call('/api/handlers/check', api)).json();
  assert.equal(finished.id, run.id);
  assert.ok(finished.started);
  assert.ok(finished.finished);
  assert.deepEqual(finished.counts, { ok: 2, broken: 1, pending: 0 });
  assert.equal(finished.handlers.find((h) => h.handler === lookupA).state, 'ok');
  const broken = finished.handlers.find((h) => h.handler === lookupB);
  assert.equal(broken.state, 'broken');
  assert.match(broken.reason, /found: expected found with at least one record/);
  const entry = (await (await call('/api/handlers', api)).json()).handlers.find((h) => h.id === lookupB);
  assert.equal(entry.health.state, 'broken');
  assert.match(entry.health.last_reason, /found:/);
});

test('a targeted canary checks only that handler and requires not_found on the negative side', async () => {
  assert.equal((await call('/api/handlers/check', api, { method: 'POST', body: '{"handler":"missing"}' })).status, 404);
  assert.equal((await call('/api/handlers/check', api, { method: 'POST', body: '{"handler":"AU-asx.com/w1"}' })).status, 422);
  const { run } = await (await call('/api/handlers/check', api, { method: 'POST', body: JSON.stringify({ handler: lookupA }) })).json();
  assert.equal(run.handlers.length, 1);
  for (let i = 0; i < 2; i++) {
    const { job } = await (await pollLookup('pc-target-check')).json();
    assert.equal(job.payload.handler, lookupA);
    await answerLookup(job, { status: 'found', records: [{ name: 'Gamuda' }] });
  }
  const { run: done } = await (await call('/api/handlers/check', api)).json();
  assert.deepEqual(done.counts, { ok: 0, broken: 1, pending: 0 });
  assert.match(done.handlers[0].reason, /not_found: expected not_found/);
});

test('lookup lease expiry wakes an already waiting worker and ordinary queued lookups time out', async (t) => {
  // Isolate the clock and queue so advancing time cannot affect earlier tests' jobs.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const isolated = await import('../server.mjs?lookup-clock');
  const service = await isolated.start(0);
  t.after(() => service.close());
  const request = (route, headers = api, body) => fetch(`http://localhost:${service.address().port}${route}`, {
    headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const first = (await (await request('/api/lookup', api, { handler: lookupA, keyword: 'Gamuda', worker: 'expired', wait: 0 })).json()).job;
  await request('/api/jobs/next?worker=expired&types=site.lookup&wait=0', wk);
  const second = (await (await request('/api/lookup', api, { handler: lookupB, keyword: 'IJM', worker: 'waiting', timeoutMs: 300000, wait: 0 })).json()).job;
  const waiting = request('/api/jobs/next?worker=waiting&types=site.lookup&wait=3', wk);
  await new Promise((r) => setTimeout(r, 100));
  // Advance one sweep at a time to observe the requeued lease before the next sweep.
  for (let i = 0; i < 37; i++) t.mock.timers.tick(5000);
  const woke = await waiting;
  assert.equal(woke.status, 200);
  assert.equal((await woke.json()).job.id, second.id);
  const expired = (await (await request(`/api/lookup/${first.id}`)).json()).job;
  assert.equal(expired.status, 'pending');
  assert.equal((await request(`/api/jobs/${first.id}/result`, wk, {
    worker: 'expired', type: 'site.lookup', ok: true, result: { result: notFound },
  })).status, 200);
  const late = (await (await request(`/api/lookup/${first.id}`)).json()).job;
  assert.equal(late.result.worker, 'expired');
  const queued = (await (await request('/api/lookup', api, { handler: lookupC, keyword: 'DBS', timeoutMs: 10000, wait: 0 })).json()).job;
  t.mock.timers.tick(15000);
  const timedOut = (await (await request(`/api/lookup/${queued.id}`)).json()).job;
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.error, /no worker claimed it within 10 s/);
  const { run } = await (await request('/api/handlers/check', api, { handler: lookupC })).json();
  t.mock.timers.tick(155000);
  const check = (await (await request('/api/handlers/check')).json()).run;
  assert.equal(check.id, run.id);
  assert.equal(check.finished, null);
  assert.equal(check.counts.pending, 1);
  for (const side of ['found', 'not_found']) {
    assert.equal((await (await request(`/api/lookup/${check.handlers[0][side].job}`)).json()).job.status, 'pending');
  }
});

test('missing handler directory starts normally with an empty library', async (t) => {
  const previous = process.env.HANDLERS_DIR;
  process.env.HANDLERS_DIR = fileURLToPath(new URL('./fixtures/handlers/missing/', import.meta.url));
  let isolated;
  try { isolated = await import('../server.mjs?missing-handlers'); }
  finally { process.env.HANDLERS_DIR = previous; }
  const service = await isolated.start(0);
  t.after(() => service.close());
  const response = await fetch(`http://localhost:${service.address().port}/api/handlers`, { headers: api });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { handlers: [] });
});

test('a started hub runs the handler check once soon after start, without waiting a whole interval', async () => {
  // A child process: the test runner's NODE_TEST_CONTEXT turns the schedule off in this one.
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, HANDLER_CHECK_INTERVAL_MS: String(24 * 3_600_000), HANDLER_CHECK_START_DELAY_MS: '100' };
  delete env.NODE_TEST_CONTEXT;
  const script = `
    const { start } = await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)});
    const s = await start(0);
    const get = async () => (await (await fetch('http://localhost:' + s.address().port + '/api/handlers/check', { headers: { authorization: 'Bearer ' + process.env.API_KEY } })).json()).run;
    const before = await get();
    await new Promise((r) => setTimeout(r, 600));
    console.log(JSON.stringify({ before, after: await get() }));
    s.closeAllConnections();
    s.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => child.on('exit', resolve));
  const { before, after } = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(before, null);
  assert.ok(after?.id, 'no check run 600 ms after start');
  assert.equal(after.handlers.length, 3);
});

test('LinkedIn is gone: no route, and a worker asking for linkedin.scrape gets nothing for it', async () => {
  assert.equal((await call('/api/linkedin', api, { method: 'POST', body: JSON.stringify({ kind: 'person', url: 'https://www.linkedin.com/in/example/' }) })).status, 404);
  assert.equal((await call('/api/jobs/next?worker=pc-old&types=linkedin.scrape&wait=0', wk)).status, 204);
});

test('AI advice answers 503 when no model is set up on the service', async () => {
  const job = (await (await call('/api/audit', api, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/', worker: 'pc-no-advice', wait: 0 }) })).json()).job;
  const r = await call(`/api/audit/${job.id}/advice`, api, { method: 'POST' });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /AGY_URL/);
});
