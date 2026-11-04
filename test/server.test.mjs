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

test('LinkedIn cooldown does not block Maps or fetch and clears independently', async () => {
  const worker = 'pc-li-cool';
  const posted = await (await call('/api/linkedin', api, {method:'POST', body:JSON.stringify({kind:'company',url:'https://linkedin.com/company/acme/',worker})})).json();
  const {job} = await (await call(`/api/jobs/next?worker=${worker}&types=linkedin.scrape&wait=0`, wk)).json();
  assert.equal(job.id, posted.job.id);
  await call(`/api/jobs/${job.id}/result`, wk, {method:'POST', body:JSON.stringify({worker,type:'linkedin.scrape',ok:false,error:'rate_limited: test',retryAfterMs:60000})});
  const state = (await (await call('/api/workers', api)).json()).workers.find(w => w.name === worker);
  assert.equal(state.coolReason, 'LinkedIn rate limited');
  assert.ok(state.linkedinCoolUntil);
  assert.equal((await call(`/api/jobs/next?worker=${worker}&types=linkedin.scrape&wait=0`, wk)).status, 204);
  const fetchJob = (await (await call('/api/fetch', api, {method:'POST',body:JSON.stringify({url:'https://example.com/',worker,wait:0})})).json()).job;
  const claimed = (await (await call(`/api/jobs/next?worker=${worker}&types=web.fetch,linkedin.scrape&wait=0`, wk)).json()).job;
  assert.equal(claimed.id, fetchJob.id);
  await call(`/api/jobs/${claimed.id}/result`, wk, {method:'POST',body:JSON.stringify({worker,ok:true,result:{}})});
  await call(`/api/jobs/next?worker=${worker}&types=web.fetch&wait=0&linkedinState=ready`, wk);
  const after = (await (await call('/api/workers', api)).json()).workers.find(w => w.name === worker);
  assert.equal(after.linkedinCoolUntil, null);
});

test('expired LinkedIn session blocks claims until worker reports renewal', async () => {
  const worker = 'pc-li-expired';
  const request = {kind:'person', url:'https://linkedin.com/in/example/', worker};
  const first = (await (await call('/api/linkedin', api, {method:'POST',body:JSON.stringify(request)})).json()).job;
  await call(`/api/jobs/next?worker=${worker}&types=linkedin.scrape&wait=0`, wk);
  await call(`/api/jobs/${first.id}/result`, wk, {method:'POST',body:JSON.stringify({worker,type:'linkedin.scrape',ok:false,error:'session_expired: login'})});
  const second = (await (await call('/api/linkedin', api, {method:'POST',body:JSON.stringify(request)})).json()).job;
  assert.equal((await call(`/api/jobs/next?worker=${worker}&types=linkedin.scrape&wait=0`, wk)).status, 204);
  const state = (await (await call('/api/workers', api)).json()).workers.find(w => w.name === worker);
  assert.equal(state.linkedinSessionExpired, true);
  const resumed = (await (await call(`/api/jobs/next?worker=${worker}&types=linkedin.scrape&wait=0&linkedinState=ready`, wk)).json()).job;
  assert.equal(resumed.id, second.id);
  await call(`/api/jobs/${second.id}/result`, wk, {method:'POST',body:JSON.stringify({worker,ok:false,error:'test complete'})});
});

test('LinkedIn job is validated and routed only to an opted-in worker', async () => {
  for (const body of [{}, {kind:'person', url:'https://example.com/in/a'}, {kind:'company', url:'https://linkedin.com/in/a'}, {kind:'person', url:'https://linkedin.com/in/a?x=1'}]) {
    assert.equal((await call('/api/linkedin', api, {method:'POST', body:JSON.stringify(body)})).status, 400);
  }
  const posted = await (await call('/api/linkedin', api, {method:'POST', body:JSON.stringify({kind:'person', url:'https://www.linkedin.com/in/example/', worker:'pc-linkedin'})})).json();
  assert.equal((await call('/api/jobs/next?worker=pc-linkedin&types=web.fetch&wait=0', wk)).status, 204);
  const {job} = await (await call('/api/jobs/next?worker=pc-linkedin&types=linkedin.scrape&wait=1', wk)).json();
  assert.equal(job.id, posted.job.id);
  assert.equal(job.type, 'linkedin.scrape');
  await call(`/api/jobs/${job.id}/result`, wk, {method:'POST', body:JSON.stringify({worker:'pc-linkedin', ok:true, result:{data:{name:'Example'}}})});
  const result = await (await call(`/api/linkedin/${job.id}`, api)).json();
  assert.equal(result.job.result.data.name, 'Example');
});

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

test('fetch checks its input', async () => {
  for (const body of [{}, { url: 'ftp://x.com/' }, { url: 'nope' }, { url: 'https://x.com/', format: 'pdf' }, { url: 'https://x.com/', timeoutMs: 1000 }]) {
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

test('package zip carries the worker key', async () => {
  const r = await call('/api/worker/package', api);
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes('LocalGmapWorker/app/worker.ps1'));
  assert.ok(buf.includes('LocalGmapWorker/app/linkedin_job.py'));
  assert.ok(buf.includes('LocalGmapWorker/app/linkedin_login.py'));
  assert.ok(buf.includes('LocalGmapWorker/app/linkedin_signin.ps1'));
  assert.ok(buf.includes('LocalGmapWorker/LinkedIn sign in.cmd'));
});
