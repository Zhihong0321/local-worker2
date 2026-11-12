// The worker's loops against a fake hub: take a website and a form, do the work, report back.
// The website check uses a name that does not resolve (no real site is read); the form is sent to
// the local fixture site. Needs a Chrome or Edge (skipped otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserPath } from '../send.mjs';
import { startSite } from './fixture-site.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, '..', 'worker.mjs');
const KEY = 'test-key-0123456789abcdef';
const skip = browserPath() ? false : 'no Chrome or Edge on this machine (set CHROME_PATH)';

function startHub(site) {
  const got = { scanTaken: false, sendTaken: false, scanDone: [], sendDone: [], assists: 0, badAuth: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ' + KEY) { got.badAuth++; res.writeHead(401); res.end('{}'); return; }
      const body = raw ? JSON.parse(raw) : {};
      const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/form-scan/worker/take') {
        if (got.scanTaken) return reply({ sites: [], leaseSeconds: 900 });
        got.scanTaken = true;
        return reply({ sites: [{ company_id: '101', company_name: 'Ghost Sdn Bhd', website: 'https://no-such-host.invalid' }], leaseSeconds: 900 });
      }
      if (req.url === '/api/form-scan/worker/done') { got.scanDone.push(body); return reply({ saved: true }); }
      if (req.url === '/api/form-send/worker/take') {
        if (got.sendTaken) return reply({ forms: [], leaseSeconds: 1200 });
        got.sendTaken = true;
        return reply({
          forms: [{
            company_id: '202', company_name: 'Fixture Sdn Bhd', website: site.url,
            subject: 'Hello Fixture Sdn Bhd', body: 'Hello Fixture Sdn Bhd, we can help.',
            sender: { name: 'Alex Gan', email: 'sender@example.com', phone: '0123456789', company: 'Eternalgy' },
          }],
          leaseSeconds: 1200,
        });
      }
      if (req.url === '/api/form-send/worker/assist') { got.assists++; return reply({ fills: [] }); }
      if (req.url === '/api/form-send/worker/done') { got.sendDone.push(body); return reply({ saved: true }); }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, got, url: `http://127.0.0.1:${server.address().port}`,
  })));
}

test('worker takes one website and one form, reports both', { skip, timeout: 240_000 }, async () => {
  const site = await startSite();
  const hub = await startHub(site);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-worker-loop-'));
  const envFile = path.join(dir, 'worker.env');
  fs.writeFileSync(envFile, `LAB_URL=${hub.url}\nGMAP_WORKER_KEY=${KEY}\nWORKER_NAME=test-loop\nCONCURRENCY=1\nSEND_LANES=1\n`);
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, FORM_WORKER_ENV: envFile, LOCALAPPDATA: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const deadline = Date.now() + 200_000;
    while ((hub.got.scanDone.length === 0 || hub.got.sendDone.length === 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(hub.got.badAuth, 0, 'every hub call carries the worker key');
    assert.equal(hub.got.scanDone.length, 1, out);
    assert.equal(hub.got.scanDone[0].worker, 'test-loop');
    assert.equal(hub.got.scanDone[0].company_id, '101');
    assert.equal(hub.got.scanDone[0].form.status, 'unreachable', JSON.stringify(hub.got.scanDone[0]));
    assert.equal(hub.got.sendDone.length, 1, out);
    assert.equal(hub.got.sendDone[0].company_id, '202');
    assert.equal(hub.got.sendDone[0].result.status, 'sent', JSON.stringify(hub.got.sendDone[0].result));
    assert.equal(site.posts.length, 1);
  } finally {
    child.kill('SIGKILL');
    hub.server.close();
    site.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
