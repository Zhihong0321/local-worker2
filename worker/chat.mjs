// One chat.ask job: forwards the prompt to the local ChatGPT bridge,
// waits for the ChatGPT web page to complete generation, and prints one JSON line.
import fs from 'node:fs';

const BRIDGE_URL = process.env.CHAT_BRIDGE_URL || 'http://127.0.0.1:8765';

async function main() {
  const specFile = process.argv[2];
  if (!specFile || !fs.existsSync(specFile)) {
    console.log(JSON.stringify({ ok: false, error: 'missing or invalid job spec file' }));
    process.exit(1);
  }

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: `invalid spec JSON: ${err.message}` }));
    process.exit(1);
  }

  const started = Date.now();
  const id = spec.id || String(Date.now());
  const prompt = spec.prompt || '';
  const timeoutMs = Number(spec.timeoutMs) || 180_000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);

    const res = await fetch(`${BRIDGE_URL}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, prompt, timeoutMs }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await res.json();
    if (!res.ok || !body.ok) {
      console.log(JSON.stringify({ ok: false, error: body.error || `bridge answered HTTP ${res.status}` }));
      process.exit(0);
    }

    const tookMs = Date.now() - started;
    console.log(JSON.stringify({
      ok: true,
      result: {
        answer: body.answer || '',
        tookMs,
      },
    }));
  } catch (err) {
    const msg = err.name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)} s` : err.message;
    console.log(JSON.stringify({ ok: false, error: `could not reach local ChatGPT bridge: ${msg}` }));
  }
}

main();
