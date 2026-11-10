// The global handlers (handlers/ALL): offline checks only. No network is used here.
// The live proof is the server's canary run (POST /api/handlers/check) on a worker PC.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = fileURLToPath(new URL('../handlers/', import.meta.url));
const index = JSON.parse(fs.readFileSync(`${DIR}ALL/index.json`, 'utf8'));

test('every global handler is indexed with its file, its current version and a canary', () => {
  const files = fs.readdirSync(`${DIR}ALL`).filter((f) => f.endsWith('.mjs'));
  assert.equal(index.handlers.length, files.length);
  for (const h of index.handlers) {
    assert.equal(h.country, 'ALL');
    assert.equal(h.scope, 'global');
    assert.equal(h.input, 'domain');
    assert.equal(h.id, `${h.task}/${h.want}`);
    const bytes = fs.readFileSync(`${DIR}${h.file}`);
    assert.equal(h.version, createHash('sha256').update(bytes).digest('hex').slice(0, 12), `${h.id}: index is out of date, run node scripts/build-global-index.mjs`);
    assert.ok(h.canary.found && h.canary.not_found);
    assert.ok(h.tier === 1 || h.tier === 2);
  }
});

test('a global handler never throws: a bad keyword comes back couldnt_check with a reason', async () => {
  for (const h of index.handlers) {
    const mod = await import(pathToFileURL(`${DIR}${h.file}`).href);
    assert.equal(typeof mod.default, 'function');
    for (const keyword of ['', '   ', 'not a domain', undefined, null, 'http://']) {
      const out = await mod.default(keyword);
      assert.equal(out.status, 'couldnt_check', `${h.id} with ${JSON.stringify(keyword)}`);
      assert.equal(out.reason, 'keyword_not_a_domain');
      assert.ok(Array.isArray(out.records));
      assert.equal(typeof out.excerpt, 'string');
    }
  }
});
