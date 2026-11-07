// The macOS worker (worker-macos/app/worker.py) is a hand port of the Windows
// worker (worker/worker.ps1). These read both as text and fail when a part that
// must match does not: the Google request, the field positions read from its
// answer, the limits, the pinned packages and the result's shape. A failure
// here means worker.ps1 changed and worker.py was not ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ps1 = fs.readFileSync(path.join(root, 'worker', 'worker.ps1'), 'utf8');
const py = fs.readFileSync(path.join(root, 'worker-macos', 'app', 'worker.py'), 'utf8');
const PORT = 'port the change to worker-macos/app/worker.py';

/** The text from `start` up to the first `end` after it. */
function block(source, start, end) {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  assert.ok(j >= 0, `no end after: ${start}`);
  return source.slice(i, j);
}

const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

/** `$Name = value` in worker.ps1, `Name = value` in worker.py. */
function constant(name) {
  const a = new RegExp(`^\\$${name} = (.+)$`, 'm').exec(ps1);
  const b = new RegExp(`^${name} = (.+)$`, 'm').exec(py);
  assert.ok(a, `worker.ps1 has no $${name}`);
  assert.ok(b, `worker.py has no ${name}`);
  return [a[1].trim(), b[1].trim()];
}

test('the Maps request is the same: pb string, URL and language', () => {
  const pieces = (fn) => quoted(fn).filter((s) => s.startsWith('!'));
  const a = pieces(block(ps1, 'function Get-Pb', '\n}'));
  const b = pieces(block(py, 'def get_pb', '\n\n'));
  assert.ok(a.length > 3);
  assert.deepEqual(b, a, `worker.ps1 changed the pb string: ${PORT}`);
  const url = (fn) => quoted(fn).find((s) => s.startsWith('https://www.google.com/search'));
  assert.equal(url(block(py, 'def get_list_page', '\n\n\n')), url(block(ps1, 'function Get-ListPage', '\n}')), `worker.ps1 changed the Maps URL: ${PORT}`);
});

test('the same field positions are read from Google\'s answer', () => {
  const a = new Set([...ps1.matchAll(/\bAt \$\w+(?:\[\$i\])? @\(([\d, ]+)\)/g)].map((m) => m[1].replace(/\s/g, '')));
  const b = new Set([...py.matchAll(/\bat\(\w+, \[([\d, ]+)\]\)/g)].map((m) => m[1].replace(/\s/g, '')));
  assert.ok(a.size > 10);
  assert.deepEqual([...b].sort(), [...a].sort(), `worker.ps1 reads different fields: ${PORT}`);
});

test('a business row has the same fields', () => {
  const a = [...block(ps1, '[void]$rows.Add([ordered]@{', '\n    })').matchAll(/^\s+(\w+) = /gm)].map((m) => m[1]);
  const b = [...block(py, 'rows.append({', '\n        })').matchAll(/^\s+'(\w+)': /gm)].map((m) => m[1]);
  assert.ok(a.length > 5);
  assert.deepEqual(b, a, `worker.ps1 changed a business row: ${PORT}`);
});

test('a scan result has the same fields', () => {
  const keys = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
  const a = keys(block(ps1, 'return [ordered]@{\n    query =', '\n  }\n}'), /(?:^|;)\s*(\w+) = /gm);
  const b = keys(block(py, "return {\n        'query'", '\n    }\n'), /'(\w+)': /g);
  assert.ok(a.length > 15);
  assert.deepEqual([...b].sort(), [...a].sort(), `worker.ps1 changed the scan result: ${PORT}`);
});

test('the limits are the same', () => {
  for (const name of ['PostMarginSec', 'BlockedRestSec', 'Page', 'MaxPages']) {
    const [a, b] = constant(name);
    assert.equal(b, a, `worker.ps1 changed ${name}: ${PORT}`);
  }
  const [a, b] = constant('DefaultCentre');
  assert.equal(b.replace(/[[\]]/g, ''), a.replace(/^@\(|\)$/g, ''), `worker.ps1 changed DefaultCentre: ${PORT}`);
  for (const [name, fallback] of [['PaceMs', /\$PaceMs = (\d+)/]]) {
    const pyDefault = new RegExp(`^${name} = .* else (\\d+)$`, 'm').exec(py);
    assert.ok(pyDefault, `worker.py has no default for ${name}`);
    assert.equal(pyDefault[1], fallback.exec(ps1)[1], `worker.ps1 changed the default ${name}: ${PORT}`);
  }
});

test('the same pinned packages are installed', () => {
  for (const name of ['FetchPackages', 'PdfPackages']) {
    const [a, b] = constant(name);
    assert.deepEqual(quoted(b), quoted(a), `worker.ps1 changed ${name}: ${PORT}`);
  }
});

test('Google refusals and streets are read the same way', () => {
  const captcha = (text) => /unusual traffic\|[^'"]+/.exec(text)[0];
  assert.equal(captcha(py), captcha(ps1), `worker.ps1 changed the captcha check: ${PORT}`);
  const street = (text) => /\^\\s\*\(\?:jalan\|jln\\\.\?\)[^'"]+/.exec(text)[0];
  assert.equal(street(py), street(ps1), `worker.ps1 changed the street pattern: ${PORT}`);
  const skip = (text) => /\[\^\\x20-\\x7e\][^'"]+/.exec(text)[0];
  assert.equal(skip(py), skip(ps1), `worker.ps1 changed which streets are skipped: ${PORT}`);
});

test('both workers take web.shot the same way: only with a browser and the portable Node, with the same spec', () => {
  assert.ok(ps1.includes("if ($script:NodeReady -and $script:ShotExe) { 'web.shot' }"), 'worker.ps1 no longer gates web.shot on a browser');
  assert.ok(py.includes("'web.shot' if NodeReady and ShotExe else None,"), `worker.py does not gate web.shot like worker.ps1: ${PORT}`);
  const a = [...block(ps1, 'url = $p.url; device = $p.device', '}\n').matchAll(/(\w+) = /g)].map((m) => m[1]);
  const b = [...block(py, "spec = {'url': p.get('url'), 'device'", '}\n').matchAll(/'(\w+)': /g)].map((m) => m[1]);
  assert.ok(a.length >= 7);
  assert.deepEqual(b, a, `worker.ps1 sends shot.mjs a different spec: ${PORT}`);
});

test('the macOS worker runs the Windows worker\'s own job scripts', () => {
  for (const name of ['fetch.py', 'audit.py', 'shot.mjs']) {
    assert.ok(py.includes(`SHARED / '${name}'`), `worker.py does not run worker/${name}`);
    assert.ok(!fs.existsSync(path.join(root, 'worker-macos', 'app', name)), `worker-macos/app/${name} is a copy that will drift: delete it`);
  }
});
