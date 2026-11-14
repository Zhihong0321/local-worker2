import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';

test('bridge distributes requests between browsers and keeps the remaining connection', async (t) => {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const bridge = spawn(process.execPath, ['worker/chat_bridge.mjs'], {
    env: { ...process.env, CHAT_BRIDGE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => bridge.kill());
  const [started] = await once(bridge.stdout, 'data');
  assert.match(started.toString(), /CHAT_BRIDGE_READY/);
  const base = `http://127.0.0.1:${port}`;
  const unready = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => unready.addEventListener('open', resolve, { once: true }));
  const rejected = await fetch(`${base}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'not-ready', prompt: 'hello' }) });
  assert.equal(rejected.status, 503);
  unready.close();
  async function browser(name) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.addEventListener('message', (event) => {
      const task = JSON.parse(event.data);
      ws.send(JSON.stringify({ id: task.id, type: 'done', ok: true, answer: name }));
      ws.send(JSON.stringify({ type: 'readiness', ready: true }));
    });
    ws.send(JSON.stringify({ type: 'readiness', ready: true }));
    t.after(() => ws.close());
    return ws;
  }
  const chrome = await browser('chrome');
  const brave = await browser('brave');
  async function ask(id) {
    const response = await fetch(`${base}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, prompt: 'hello' }) });
    return response.json();
  }
  assert.equal((await ask('one')).answer, 'chrome');
  assert.equal((await ask('two')).answer, 'brave');
  const closed = new Promise((resolve) => brave.addEventListener('close', resolve, { once: true }));
  brave.close();
  await closed;
  assert.equal((await (await fetch(`${base}/health`)).json()).connected, true);
  assert.equal((await ask('three')).answer, 'chrome');
  chrome.close();
});
